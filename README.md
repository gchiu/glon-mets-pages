# glon-mets-pages

Deployment output only: a public test build of a journey-companion web app.
Built from source commit `cb0ca06`. Do not edit here.

The app starts as a real journey from the user's own location and the current time.
A built-in simulation, for testing only, runs when `?demo=1` is added to the address.

Places the user saves (including Home) and their fare type stay in their own browser. "Search for a
place or address" sends only the text the user typed, when they press Search, to OpenStreetMap's
Nominatim service (Wellington region only); no location or saved place is sent.

Bus times are labelled by where they come from:

- **Demo**: the simulation's journeys and realtime (`?demo=1` only) are demonstration data.
- **Scheduled**: the Route 21 and Route 24 timetables from the Metlink GTFS feed (Greater Wellington
  Regional Council, CC BY 4.0), used whenever no fresh live data backs a time.
- **Live**: Metlink realtime stop predictions, only when the user enters their own Metlink
  API key in the app's "Metlink realtime" panel. That key stays in the user's own browser
  and is sent only to the Metlink API.

No API key is included in this deployment: without the user's own key the app shows
Scheduled and Demo times only. Fare rules are illustrative (not real fares), and the
profile is a neutral demonstration profile.
