export namespace main {
	
	export class EpubPayload {
	    path: string;
	    name: string;
	    url: string;
	    bookHash: string;
	
	    static createFrom(source: any = {}) {
	        return new EpubPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.url = source["url"];
	        this.bookHash = source["bookHash"];
	    }
	}
	export class SessionState {
	    bookPath: string;
	    bookHash: string;
	    chapterHref: string;
	    cfi: string;
	    updatedAt: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.bookPath = source["bookPath"];
	        this.bookHash = source["bookHash"];
	        this.chapterHref = source["chapterHref"];
	        this.cfi = source["cfi"];
	        this.updatedAt = source["updatedAt"];
	    }
	}

}

