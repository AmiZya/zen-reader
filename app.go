package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx              context.Context
	sessionMu        sync.Mutex
	openBooksMu      sync.RWMutex
	openBooksByToken map[string]string
}

// EpubPayload is a bound DTO returned to the frontend.
type EpubPayload struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	BookHash string `json:"bookHash"`
}

// SessionState stores the last known reading position.
type SessionState struct {
	BookPath    string `json:"bookPath"`
	BookHash    string `json:"bookHash"`
	ChapterHref string `json:"chapterHref"`
	CFI         string `json:"cfi"`
	UpdatedAt   string `json:"updatedAt"`
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		openBooksByToken: make(map[string]string),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// OpenEpubDialog opens a native file picker and returns the selected EPUB payload.
func (a *App) OpenEpubDialog() (*EpubPayload, error) {
	if a.ctx == nil {
		return nil, errors.New("application context unavailable")
	}

	selectedPath, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open EPUB",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "EPUB files (*.epub)",
				Pattern:     "*.epub",
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("open dialog failed: %w", err)
	}

	if selectedPath == "" {
		return nil, nil
	}

	return a.readEpubPayload(selectedPath)
}

// LoadEpubFromPath loads an EPUB from disk and returns its payload.
func (a *App) LoadEpubFromPath(path string) (*EpubPayload, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("empty EPUB path")
	}

	return a.readEpubPayload(path)
}

// LoadSession loads the persisted reader session.
func (a *App) LoadSession() (*SessionState, error) {
	sessionPath, err := a.sessionPath()
	if err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(sessionPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read session failed: %w", err)
	}

	if len(raw) == 0 {
		return nil, nil
	}

	var state SessionState
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, fmt.Errorf("invalid session file: %w", err)
	}

	return &state, nil
}

// SaveSession stores the current reader session atomically.
func (a *App) SaveSession(state SessionState) error {
	if strings.TrimSpace(state.BookPath) == "" {
		return errors.New("session requires a bookPath")
	}

	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	raw, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal session failed: %w", err)
	}

	sessionPath, err := a.sessionPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(sessionPath), 0o755); err != nil {
		return fmt.Errorf("create session directory failed: %w", err)
	}

	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()

	tmpPath := sessionPath + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o600); err != nil {
		return fmt.Errorf("write temp session failed: %w", err)
	}

	if err := os.Rename(tmpPath, sessionPath); err != nil {
		return fmt.Errorf("replace session file failed: %w", err)
	}

	return nil
}

// ClearSession deletes the persisted reader session.
func (a *App) ClearSession() error {
	sessionPath, err := a.sessionPath()
	if err != nil {
		return err
	}

	if err := os.Remove(sessionPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear session failed: %w", err)
	}

	return nil
}

func (a *App) serveEpubHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	const prefix = "/__epub/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	token := strings.TrimPrefix(r.URL.Path, prefix)
	token = strings.TrimSuffix(token, ".epub")
	token = strings.TrimSpace(token)
	if token == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	bookPath, ok := a.lookupBookPathByToken(token)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	if !strings.EqualFold(filepath.Ext(bookPath), ".epub") {
		w.WriteHeader(http.StatusUnsupportedMediaType)
		return
	}

	if _, err := os.Stat(bookPath); err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/epub+zip")
	http.ServeFile(w, r, bookPath)
}

func (a *App) lookupBookPathByToken(token string) (string, bool) {
	a.openBooksMu.RLock()
	defer a.openBooksMu.RUnlock()

	bookPath, ok := a.openBooksByToken[token]
	return bookPath, ok
}

func (a *App) readEpubPayload(path string) (*EpubPayload, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve EPUB path failed: %w", err)
	}

	if !strings.EqualFold(filepath.Ext(absPath), ".epub") {
		return nil, fmt.Errorf("unsupported file extension: %s", filepath.Ext(absPath))
	}

	info, err := os.Stat(absPath)
	if err != nil {
		return nil, fmt.Errorf("stat EPUB failed: %w", err)
	}

	if info.IsDir() {
		return nil, errors.New("EPUB path points to a directory")
	}

	token, err := newBookToken()
	if err != nil {
		return nil, err
	}

	a.openBooksMu.Lock()
	a.openBooksByToken[token] = absPath
	a.openBooksMu.Unlock()

	hashSource := fmt.Sprintf("%s|%d|%d", absPath, info.Size(), info.ModTime().UTC().UnixNano())
	hash := sha256.Sum256([]byte(hashSource))

	bookURL := fmt.Sprintf("/__epub/%s.epub", token)

	return &EpubPayload{
		Path:     absPath,
		Name:     filepath.Base(absPath),
		URL:      bookURL,
		BookHash: hex.EncodeToString(hash[:]),
	}, nil
}

func (a *App) sessionPath() (string, error) {
	baseDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory failed: %w", err)
	}

	return filepath.Join(baseDir, "zen-reader", "session.json"), nil
}

func newBookToken() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate token failed: %w", err)
	}

	return hex.EncodeToString(raw), nil
}
