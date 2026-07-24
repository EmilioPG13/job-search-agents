// Registered job sources. Each exports { name, fetchJobs } and returns rows in
// the shared shape the jobs table expects, so Discovery never needs to know
// which board a posting came from.
//
// Arbeitnow was evaluated and deliberately left out: 100 postings but only 7
// remote, and the ones that passed the prefilter were all onsite German roles
// (Munich, Dresden, Kiel). Good source, wrong shape for a remote search.
// Re-measure with src/tools/compare-sources.js before adding anything here.

module.exports = [
  require('./hackernews'),
  require('./remoteok'),
  require('./remotive'),
];
