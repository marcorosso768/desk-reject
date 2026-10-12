/*
 * What's new: the guided tour shown once after an update (and a short welcome
 * for a new install). For each release, add an entry at the top:
 *   version  the release that introduces the steps
 *   steps    in order; each one has
 *              target   CSS selector of what to point at (omit: centred card)
 *              title, text
 *              desktop  true = only in the desktop app, false = only on the web
 *              last     true = shown at the end of the tour (e.g. how to see it again)
 * Keep it short: 2-4 steps per release.
 */
window.DESK_REJECT_WHATSNEW = {
  welcome: [
    { target: "#board", title: "Press a pad", text: "Each pad reads a comment aloud. The keys follow the grid: 1 2 3 4, Q W E R, A S D F, Z X C V." },
    { target: "#random-btn", title: "Reviewer 2 decides", text: "The stamp (or Space) plays a random comment, pads and reserve included." },
    { target: "#report-open", title: "The decision letter", text: "At the end of the talk, Generate report stamps the decision and makes the PDF." },
    { target: "#edit-toggle", title: "Make it yours", text: "Write, record or move comments under Edit pads; a + on an empty pad adds one there." }
  ],
  releases: [
    {
      version: "1.3.0",
      steps: [
        { desktop: true, title: "Updates, in their own window", text: "Check for Updates… now shows a small window with the download, a progress bar and Cancel, then Install and Relaunch, or Later to install when you quit." },
        { desktop: true, title: "About Desk Reject", text: "In the app menu: the version and the credits. And What's New, in the Help menu, shows this tour again." },
        { desktop: false, last: true, target: "#settings-open", title: "This tour, again", text: "Settings → What's new shows it again whenever you like." }
      ]
    },
    {
      version: "1.2.2",
      steps: [
        { target: "#bank-bar", title: "Up to eight pad banks", text: "A to D are ready; + adds up to H, and Edit pads removes them. Swipe left or right on the pads, or with two fingers on a trackpad, to change bank." },
        { target: "#report-open", title: "The decision, stamped", text: "Generate report now stamps the decision on the screen with a sound, and confetti for the lucky ones. The PDF adds the authors' (sarcastic) response to Reviewer 2." },
        { target: "#settings-open", title: "Statistics", text: "Settings → Statistics counts the comments played, the decisions, the acceptance rate and the most battered paper." }
      ]
    },
    {
      version: "1.2.1",
      steps: [
        { target: "#review-new", title: "New review", text: "Starts a new manuscript in one click, without opening the report." }
      ]
    }
  ]
};
