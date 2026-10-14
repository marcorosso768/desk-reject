# Changelog

## 1.3.6

- New "update available" window. It shows what is new, read from this changelog, with Skip This Version, Later and Install.
- Referee report: the comments are written as Reviewer 2's thoughts while reading the paper ("Looking at Table 2, my first reaction was: ..."), with a different lead-in for each and varied wording for comments made more than once; no more references to the seminar in the report.
- Authors' reply: the "different field" answer rewritten to be clearer.
- The report's Download PDF / Save PDF button has the same size as the buttons next to it.

## 1.3.5

- Referee report: the decision letter no longer lists the comments in the order they were played. It contains Reviewer 2's report, in prose: each comment once (with how many times it was made), grouped from minor comments to major concerns to fundamental problems. The report window shows the same list, without repetitions.
- The authors' reply no longer opens with "Dear Reviewer 2," (its first sentence already addresses the referee); one closing line rewritten to be clearer; "Why not use machine learning?" and similar comments are answered as a method question.

## 1.3.4

- Referee report: the authors' reply is now a single letter instead of a list. It is built from the comments played: an opening, one paragraph per theme the referee touched (identification, contribution, literature, statistics, presentation, verdict) quoting the comments and answering them, one or two ironic comparisons, and a closing that follows the decision. Drawn at random every time.

## 1.3.3

- Two-finger swipe on a trackpad: works anywhere in the window, in both directions, and a second swipe right after the first is no longer swallowed by the inertia of the previous one.

## 1.3.2

- Desktop: the app window (and the update and About windows) opens in the exact centre of the screen it is on, and shrinks to fit a small screen.

## 1.3.1

- What's new: after an update, a short guided tour (spotlight and card, Back / Next / Skip) shows the new features once; a first visit gets a four-step welcome instead. See it again in *Settings → What's new* or, in the desktop app, *Help → What's New*. Any other key closes it, so it never gets in the way of a seminar.

## 1.3.0

- Desktop: updates in a small window of their own, Sparkle style: app icon, status ("Checking for updates…", download with megabytes and progress bar, "Verifying and extracting…"), **Cancel**, and **Install and Relaunch** / **Later** when ready. "You're up to date!" with **Version History**; "A new version is available" with the release notes, **Install Update**, **Remind Me Later**, **Skip This Version**. The progress banner at the bottom of the page is gone.
- Desktop: a new About window: icon, version and copyright on the left; project links and credits (typefaces, libraries, license) on the right.

## 1.2.3

- macOS: the icon with the dark stamp in dark mode (fixed in 1.2.2) is confirmed in the Icon Composer file: the "Stamp" layer has only `image-name-specializations`.
- macOS: after an update that changes the icon, Dock and Finder show the new one right away, without logging out (the app re-registers itself with Launch Services and restarts the Dock once, only when the icon has changed).

## 1.2.2

- Pad banks: a new board starts with *A*–*D* (*C* and *D* empty); **+** adds up to *H*, and any bank can be removed under *Edit pads*. Boards trimmed to *A*–*B* by 1.2.0–1.2.1 get *C* and *D* back once.
- Swipe left or right on the pads (touch screens) or with two fingers on a trackpad to change pad bank.
- The decision is stamped on the screen when the report opens, with a synthesised sound, and confetti for an accept or a minor revision (*Settings → Report*).
- The PDF adds the authors' sarcastic response to Reviewer 2, one random reply per comment (optional, in the report).
- *Settings → Statistics*: comments played, decisions, acceptance rate, most battered paper, favourite comments.
- Settings use smaller type.
- macOS 26: the app icon now uses the dark stamp in dark mode (the Icon Composer layer had both `image-name` and `image-name-specializations`, so `actool` ignored the dark variant).
