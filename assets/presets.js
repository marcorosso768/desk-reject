/*
 * Built-in boards. Each comment has:
 *   text      what gets spoken (and shown)
 *   severity  "comment" | "revise" | "reject"  (ink colour on the board)
 *   board     true = a pad: the first 16 fill bank A, the next 16 bank B;
 *             false = in the reserve, only drawn by the Reviewer 2 stamp
 *
 * To add a board, append an object with a unique id. Keep phrases short:
 * one sentence reads better aloud than a paragraph.
 */
window.DESK_REJECT_PRESETS = [
  {
    id: "reviewer2-en",
    name: "Reviewer 2",
    // Pads fill bank A first, then B (16 each), in the order below.
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

      // bank B: the harsher comments
      { text: "This paper answers a question nobody asked.", severity: "reject", board: true },
      { text: "The contribution is, at best, marginal.", severity: "reject", board: true },
      { text: "Your standard errors are a work of fiction.", severity: "revise", board: true },
      { text: "This is p-hacking with extra steps.", severity: "reject", board: true },
      { text: "Even the placebo test is significant.", severity: "revise", board: true },
      { text: "I am not convinced, and I will not be convinced.", severity: "reject", board: true },
      { text: "The figures are beautiful. The paper is not.", severity: "comment", board: true },
      { text: "Please drop the paper and keep the appendix.", severity: "comment", board: true },
      { text: "A fishing expedition with fixed effects.", severity: "revise", board: true },
      { text: "The abstract overpromises. The paper underdelivers.", severity: "comment", board: true },
      { text: "Interesting data. Pity about the question.", severity: "comment", board: true },
      { text: "Why is this a paper and not a footnote?", severity: "reject", board: true },
      { text: "With this sample, you can prove anything.", severity: "revise", board: true },
      { text: "The theory section is purely decorative.", severity: "revise", board: true },
      { text: "Have you considered a different field?", severity: "reject", board: true },
      { text: "Reject. Do not resubmit.", severity: "reject", board: true },

      // reserve: no pad, drawn only by the stamp
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
      { text: "Reject. I have no further comments.", severity: "reject", board: false },
      { text: "Your instrument is neither relevant nor excludable.", severity: "revise", board: false },
      { text: "This was settled in 1974.", severity: "comment", board: false },
      { text: "The literature review stops in 2009.", severity: "comment", board: false },
      { text: "No amount of robustness checks will save this.", severity: "reject", board: false },
      { text: "I reviewed this for another journal. My opinion has not changed.", severity: "reject", board: false },
      { text: "This belongs in a policy brief, not a journal.", severity: "reject", board: false }
    ]
  }
];
