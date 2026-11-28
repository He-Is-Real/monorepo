# Errors and database restarts

Who: Visitor, Signed-in person, Moderator, Admin, the system.
Data: none.
Next id: REQ-ERR-033

## When something goes wrong on our side

- **REQ-ERR-001** When something goes wrong on our side (a server error, a technical refusal, a rate limit, an answer that could not be read), the website says only "Something went wrong. Please try again later." on every page, admin pages included. [J-2026-11-09-ERR]
- **REQ-ERR-002** The website never shows an HTTP status, error code, error type or what the server is doing; the logs keep the full detail. [J-2026-11-09-ERR]
  Not: the database restart, which is named with its countdown (REQ-ERR-020).
- **REQ-ERR-032** An error message never repeats story text or other personal data. [D30]
- **REQ-ERR-003** Where it helps, the generic message adds what of the person's is safe, for example "Your story is saved.". [J-2026-11-09-ERR]
- **REQ-ERR-004** When the page's own JavaScript fails in the browser, it says "This page stopped working. Reloading it usually fixes this.", with "Reload page" and "Go to the home page". [LG-13c]
  Not: a page that fails while the server builds it, which shows the generic message.
- **REQ-ERR-005** When a call from the browser to our APIs gets no answer (offline, or none within the time allowed), it says "We couldn't reach He Is Real. Check your internet connection and try again." [LG-13c]
- **REQ-ERR-006** For REQ-ERR-005, a screen that did not load has a "Try again" button; after a button press (Save, Send, Delete) that button is how the person tries again, followed by what of theirs is safe ("Your story is kept on this device."). [LG-13c]
- **REQ-ERR-008** Every error message from REQ-ERR-001 to REQ-ERR-007, and the restart countdown, shows a reference under it: a small quiet line "Reference: 0193…" with a Copy button. [LG-1]
- **REQ-ERR-009** The message on a card's player has a reference but no Copy button, because it sits over the picture and takes no presses; the reference can still be selected. [LG-1]
- **REQ-ERR-010** The reference is a UUID v7 that means nothing to the person; the browser makes one before each call to our APIs and sends it as the call's trace id, so the API's log line has the same one. [LG-1b]
- **REQ-ERR-011** When there is nothing to link (a page that could not be made, a crash in the page), the error screen makes a fresh reference. [LG-1b]
- **REQ-ERR-012** Messages about the person's own input have no reference. [LG-1]
- **REQ-ERR-013** When the page's JavaScript crashes, or a call gets no answer, the browser sends api-user one small report: the reference, the page's path and which of the two it was. [LG-1c]
- **REQ-ERR-014** A "no answer" report is sent once the page can reach us again; reports are kept in the page's memory only, never the browser's storage, and are lost if the page closes first. [LG-9a]
- **REQ-ERR-015** The browser never reports server errors; the servers log them. [LG-1c]
- **REQ-ERR-016** Mistakes people can fix stay visible: a field too long, a file too big, a limit reached, a story changed in another tab. [J-2026-11-09-ERR]
- **REQ-ERR-017** The website shows an API's own message only for codes on its list of input refusals (`INPUT_REFUSALS` in `apps/web/src/lib/api-user.ts`); any other code gets the generic message. [J-2026-11-09-ERR]
- **REQ-ERR-018** Pages that expect "not found" or "not allowed" explain it themselves, for example "This draft no longer exists" or "This page is for admins". [J-2026-11-09-ERR]

## When the database restarts

The database runs on Google's Spot capacity in dev and production; Google can take it back at any time.

- **REQ-ERR-019** When Google takes the database's Spot capacity back, the database restarts elsewhere within a few minutes and no data is lost. [J-2026-11-07-ERR]
- **REQ-ERR-020** While the database restarts, everything except public browsing (signed-in pages, saving, sharing, uploads, admin pages) shows "Our compute is currently restarting. Please try again in about 2 minutes." [J-2026-11-09-ERR]
- **REQ-ERR-031** While the database cannot be reached, every request not answered from the kept public answers, the sign-in lookup included, is answered at once with the restarting message and when to try again; nothing hangs. [J-2026-11-07-ARC]
- **REQ-ERR-021** The minutes count down in the browser from the server's estimate, in whole minutes rounded up; when the countdown runs out it says "Please try again later." instead, never "about 1 minute" or 0. [J-2026-11-09-ERR]
- **REQ-ERR-022** Without JavaScript, the page shows the server's estimate as it was. [J-2026-11-09-ERR]
- **REQ-ERR-023** After a save, a submit or an upload, the restart message shows at the bottom of the screen and the page keeps what the person typed. [J-2026-11-09-ERR]
- **REQ-ERR-024** A submit or an upload in the share flow says the restart message where it was tried, adding "Your story is saved.". [J-2026-11-09-ERR]
- **REQ-ERR-025** Other places that show their own error after an action (saving a draft, admin pages) show "Something went wrong. Please try again later." there, with the named countdown at the bottom. [J-2026-11-09-ERR]
- **REQ-ERR-026** The estimate is 2 minutes (`DATABASE_RESTART_ESTIMATE_SECONDS`), counted from when that copy of the service first saw the database go, never less than 1 minute. [J-2026-11-07-ERR]
- **REQ-ERR-027** The message at the bottom of the screen goes as soon as the next thing the browser asks api-user or api-admin is answered, on the same page or another one. [J-2026-11-07-ERR]
- **REQ-ERR-028** A copy of a service that starts while the database is away starts anyway and gives the restart message, counted from when it first failed to connect, until it has connected. [J-2026-11-07-ERR]
- **REQ-ERR-029** A copy whose sign-in the database answers and refuses (a wrong password, an unknown namespace or database, a permission error) does not start, so a broken deploy never replaces the working version. [J-2026-11-08-ERR]
- **REQ-ERR-030** Before a copy first connects, only "no answer" counts as a restart; once it has connected, every later failure counts as a restart. [J-2026-11-08-ERR]
