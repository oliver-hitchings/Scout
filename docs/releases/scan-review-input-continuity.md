# Keep scan review usable during startup refreshes

A late initial configuration response could remove the scan-review button
between mouse-down and mouse-up, swallowing the click. The Jobs view now keeps
unchanged controls connected by comparing freshly rendered DOM, including
expanded job details. Changed job facts, preferences and application-file actions
continue to refresh, and live feedback editors keep their text and save handler.

Synthetic browser regressions release the held setup response during actual
pointer input, then require the complete zero-keeper audit or the job feedback
editor. The original audit assertions remain in force.
