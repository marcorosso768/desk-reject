/*
 * Built-in boards. Each comment has:
 *   text      what gets spoken (and shown)
 *   severity  "comment" | "revise" | "reject"  (ink colour on the board)
 *   board     true = a pad on the board (the first 16 get keyboard keys);
 *             false = in the reserve, only drawn by the Reviewer 2 stamp
 *
 * To add a board, append an object with a unique id. Keep phrases short:
 * one sentence reads better aloud than a paragraph.
 */
window.DESK_REJECT_PRESETS = [
  {
    id: "reviewer2-en",
    name: "Reviewer 2",
    lang: "en",
    comments: [
      { text: "Why should I care?", severity: "comment", board: true },
      { text: "Is this economics?", severity: "comment", board: true },
      { text: "What is the contribution?", severity: "comment", board: true },
      { text: "Please cite my paper.", severity: "comment", board: true },
      { text: "Endogeneity!", severity: "revise", board: true },
      { text: "Correlation is not causation.", severity: "revise", board: true },
      { text: "Parallel trends? I am not convinced.", severity: "revise", board: true },
      { text: "Have you tried Callaway and Sant'Anna?", severity: "revise", board: true },
      { text: "Weak first stage!", severity: "revise", board: true },
      { text: "One more robustness check.", severity: "revise", board: true },
      { text: "My student did this in 2014.", severity: "comment", board: true },
      { text: "Statistically significant, economically irrelevant.", severity: "revise", board: true },
      { text: "I didn't even finish the abstract.", severity: "reject", board: true },
      { text: "This is not of general interest.", severity: "reject", board: true },
      { text: "Better suited for a field journal.", severity: "reject", board: true },
      { text: "Desk reject!", severity: "reject", board: true },

      { text: "Interesting paper. However.", severity: "comment", board: false },
      { text: "I am not sure what we learn from this.", severity: "comment", board: false },
      { text: "This is well known.", severity: "comment", board: false },
      { text: "Interesting, but not surprising.", severity: "comment", board: false },
      { text: "Who is the audience for this paper?", severity: "comment", board: false },
      { text: "This is a nice descriptive exercise.", severity: "comment", board: false },
      { text: "The authors seem unaware of the literature.", severity: "comment", board: false },
      { text: "The paper is too long.", severity: "comment", board: false },
      { text: "Too many robustness checks.", severity: "comment", board: false },
      { text: "What about reverse causality?", severity: "revise", board: false },
      { text: "Where is the placebo test?", severity: "revise", board: false },
      { text: "Show me the event study.", severity: "revise", board: false },
      { text: "The exclusion restriction is not credible.", severity: "revise", board: false },
      { text: "Did you cluster at the right level? I doubt it.", severity: "revise", board: false },
      { text: "Two-way fixed effects are biased, you know.", severity: "revise", board: false },
      { text: "The results are driven by outliers.", severity: "revise", board: false },
      { text: "Where is the model?", severity: "revise", board: false },
      { text: "Why not use machine learning?", severity: "revise", board: false },
      { text: "Have you considered general equilibrium effects?", severity: "revise", board: false },
      { text: "The authors should write a different paper.", severity: "reject", board: false },
      { text: "Reject and resubmit.", severity: "reject", board: false },
      { text: "Reject. I have no further comments.", severity: "reject", board: false }
    ]
  }
];
