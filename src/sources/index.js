// Registered job sources. Each exports { name, fetchJobs } and returns rows in
// the shared shape the jobs table expects, so Discovery never needs to know
// which board a posting came from.
//
// Measure before adding: src/tools/compare-sources.js reports how many
// postings from a source survive the prefilter. Reputation is a poor guide —
// RemoteOK is well known and yields 7%.
//
// Evaluated and deliberately excluded:
//
//   Arbeitnow      100 postings, only 7 remote; the ones that passed the
//                  prefilter were onsite German roles. Wrong shape.
//   Indeed         Publisher API shut down in 2024; access is partner-only and
//                  the alternatives are paid scrapers.
//   LinkedIn,      No public job-search API. Reaching them means defeating bot
//   Glassdoor,     detection, which this project won't do.
//   Computrabajo,
//   OCC Mundial,
//   Echo Jobs
//   Himalayas,     Live and free, but the sample skewed non-engineering
//   Jobicy         (medical, project management). Revisit if volume is needed.

module.exports = [
  require('./companyboards'),
  require('./hackernews'),
  require('./getonbrd'),
  require('./weworkremotely'),
  require('./remoteok'),
  require('./remotive'),
];
