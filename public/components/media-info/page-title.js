import { APP_EVENTS, LOADING_EVENTS, MEDIA_INFO_EVENTS } from "../../shared/events.js";
import { pageTitle } from "../../domain/media-info.js";
let media = null;
let index = -1;
document.addEventListener(MEDIA_INFO_EVENTS.CHANGED, e => { media = e.detail; document.title = pageTitle(media, index); });
document.addEventListener(LOADING_EVENTS.FILE_CHOSEN, e => { index = e.detail?.fileIndex ?? -1; document.title = pageTitle(media, index); });
document.addEventListener(APP_EVENTS.RESET_TO_PICKER, () => { media = null; index = -1; document.title = "Torrent TV"; });
