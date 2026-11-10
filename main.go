package main

import (
	"embed"
	"net/http"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "Zen Reader",
		Width:     1320,
		Height:    860,
		MinWidth:  980,
		MinHeight: 640,
		AssetServer: &assetserver.Options{
			Assets: assets,
			Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				app.serveEpubHTTP(writer, request)
			}),
		},
		BackgroundColour: &options.RGBA{R: 244, G: 239, B: 228, A: 255},
		OnStartup:        app.startup,
		Mac: &mac.Options{
			About: &mac.AboutInfo{
				Title:   "Zen Reader",
				Message: "Developped with Love by Amine Zyad",
				Icon:    appIcon,
			},
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
