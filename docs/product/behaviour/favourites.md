# Favourites

Who: Visitor, Signed-in person, the system.
Data: `docs/db-permissions.md#stories-schema-04-storiessurql`
Next id: REQ-FAV-025

## Hearts

- **REQ-FAV-001** A Signed-in person hearts a story on its card or its page. [J-2026-10-25-FAV]
- **REQ-FAV-023** A person can have only one heart on a story. [PR-117]
- **REQ-FAV-002** Hearts are private: only the person sees theirs, and there are no counts. [J-2026-10-25-FAV]
- **REQ-FAV-024** Only the person adds or removes their own hearts, and a heart never changes once made. [J-2026-10-25-DB]
- **REQ-FAV-003** Only a public story can be hearted; a story that stops being public stays hearted but doesn't show. [J-2026-10-25-FAV]
- **REQ-FAV-004** While a person is signed out, or before they agree to the terms of use, their hearts are kept in the browser only, with no expiry, and never sent to us. [J-2026-10-28-FAV]
- **REQ-FAV-005** After signing in, the site offers to add the browser's hearts to the account; they are added only if the person chooses to. [J-2026-10-28-FAV]
- **REQ-FAV-006** Seeing or removing your hearts never needs an agreement. [F3]
- **REQ-FAV-007** A heart's time is the moment it was made, taken from its id; nobody can set it by hand. [R14]
- **REQ-FAV-008** A story's owner sees how many hearts each of their stories has, never who gave them. (planned) [J-2026-10-25-FAV]

## Favourites only

- **REQ-FAV-009** There is no favourites page: `/favourites` and `/account/favourites` show the normal "not found" page. [J-2026-11-14-FAV]
- **REQ-FAV-010** Browse has a "Favourites only" switch that shows the person's hearted stories instead of every story, laid out like browse (3 columns on desktop, then 2, then 1). [J-2026-11-14-FAV]
- **REQ-FAV-011** With the switch on, a Signed-in person sees the account's hearts and a Visitor sees the hearts kept in this browser. [J-2026-11-14-FAV]
- **REQ-FAV-012** The switch is kept in the address, so Back and reloads keep it. [J-2026-11-14-FAV]
- **REQ-FAV-013** The switch shows from the moment the page appears, for everyone, and works at once, so the filters never move once shown. [BS-9]
- **REQ-FAV-014** When the switch is turned on before the page knows who is looking, the list waits, then shows the account's or this browser's hearts; none gives the usual empty list. [BS-9]
- **REQ-FAV-015** Without JavaScript there is no switch. [BS-9]

## Filters on favourites

- **REQ-FAV-016** With "Favourites only" on, browse's search, sort, format and theme filters stay, mean what they mean on browse, and work on the favourites, kept in the address like browse's. [J-2026-11-14-FAV]
- **REQ-FAV-017** The whole favourites list is loaded and filtered in the browser. [J-2026-11-14-FAV]
  Why: people aren't expected to have more than about 100 hearts; optimising comes later.
- **REQ-FAV-018** A theme in the address applies only if browse lists that theme, one of the favourites carries it, or the theme list couldn't be read; otherwise it filters nothing, as browse does for a missing or deleted theme. [J-2026-11-14-FAV]
- **REQ-FAV-019** With stacked themes, a favourite shows only if it has every chosen theme that applies; a theme that applies but no favourite has shows none. [BS-6]
- **REQ-FAV-020** A real theme that isn't highlighted and that no published story uses filters nothing on favourites, while browse shows no stories for it. [J-2026-11-14-FAV]
- **REQ-FAV-021** "Latest first" and "Oldest first" sort favourites by when the story was published, not when it was hearted; "Best match" puts stories where the words appear most often first. [J-2026-11-14-FAV]
- **REQ-FAV-022** Search finds favourites with every word of the search in the title, description or theme names, ignoring case and accents and matching inside longer words; it doesn't search a written story's full text. [J-2026-11-14-FAV]
