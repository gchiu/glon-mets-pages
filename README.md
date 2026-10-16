# glon-mets-pages

Deployment output only: a public test build of a journey-companion web app.
Built from source commit `2dc5a59`. Do not edit here.

Bus times are labelled by where they come from:

- **Demo**: the built-in simulation's journeys and realtime are demonstration data.
- **Scheduled**: the Route 21 timetable from the Metlink GTFS feed (Greater Wellington
  Regional Council, CC BY 4.0), used whenever no fresh live data backs a time.
- **Live**: Metlink realtime stop predictions, only when the user enters their own Metlink
  API key in the app's "Metlink realtime" panel. That key stays in the user's own browser
  and is sent only to the Metlink API.

No API key is included in this deployment: without the user's own key the app shows
Scheduled and Demo times only. Fare rules are illustrative (not real fares), and the
profile is a neutral demonstration profile.
