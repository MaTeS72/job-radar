# job-radar

A job scanner for people looking for software work from Czechia. It reads Czech
job boards, international search sources and company career sites, scores every
listing against a search profile, and reports what is new. It runs on its own
or as a [Claude Code](https://claude.com/claude-code) plugin, and strong fits
can be sent to the [career-ops](https://github.com/career-ops-hq/career-ops)
inbox for evaluation.

It exists because the career-ops scanner filters on job titles only and has few
Czech sources. The radar reads the full description of every plausible listing,
so "Software Developer" with Flutter in the text is found, and "AI Engineer"
that is really Python model training is flagged.

No AI model is called and nothing is paid for: scoring is keyword rules you can
read and change.

The built-in profile looks for senior Flutter and mobile, agentic and AI-native
engineering, and product roles, for someone living in Prague. A few lines in a
file of your own change it to your search (see [Your settings](#your-settings-and-results)).
One part is not a setting yet: where a job may be. Prague, remote from Czechia
and remote across Europe count as a fit; that logic is in `src/location.mjs`.

## Install

### As a Claude Code plugin

```text
/plugin install job-radar --marketplace MaTeS72/job-radar
```

That line needs Claude Code 2.1.275 or newer. On an older version use
`/plugin marketplace add MaTeS72/job-radar` and then
`/plugin install job-radar@job-radar`. In a terminal the same commands start
with `claude plugin` instead of `/plugin`.

Then ask Claude to "scan for jobs", or type `/job-radar:radar`. On first use it
installs the one dependency, creates your settings files and asks what you are
looking for. The plugin works in every Claude account signed in on that
computer; on another computer, install it again and copy your data folder over.

### On its own

```bash
git clone https://github.com/MaTeS72/job-radar.git
cd job-radar
npm install                      # one dependency: yaml
node radar.mjs init              # creates your settings files
node radar.mjs scan --verbose    # reads everything, writes the report
```

It needs Node 20 or newer.

## Your settings and results

Everything that is yours lives outside the code, in `~/job-radar-data` (set
`JOB_RADAR_HOME` to use another folder). An update of job-radar never touches it.

```
config/profile.yml      what you want different from the built-in profile
config/sources.yml      the same for the sources and their searches
config/companies.yml    career sites of your own, and built-in ones to leave out
out/latest.md           the last report        out/radar-<date>.md   one per day
state/                  what was already reported, saved job pages, run history
```

`node radar.mjs init` creates the three settings files with examples, and
`node radar.mjs doctor` shows where everything is.

Each of your files is laid over the built-in file of the same name in the code's
`config/` folder, so it holds only what you want different:

```yaml
# ~/job-radar-data/config/profile.yml
experience_years: 5                  # an ad asking for clearly more gets a note
salary: { currency: CZK, target_monthly_min: 100000 }   # an ad stating less gets a note

thresholds: { strong: 70 }           # a value replaces the built-in value; maps are merged
exclude_title+: [wordpress]          # name+ adds to a list
exclude_title-: [designer]           # name- takes out of a list
```

A list written without `+` or `-` replaces the built-in list. `companies.yml`
works by name: your `companies:` are added to the built-in list (an entry with a
built-in company's name replaces it), and `skip: ["Name"]` leaves a built-in
company out.

## Use

| Command | What it does |
|---|---|
| `scan` | Reads every source that is on, writes `out/latest.md` and `out/radar-<date>.md`. `--sources a,b` reads only those. `--push` also sends new strong fits to career-ops. `--dry` leaves no trace, so the next scan shows the same jobs again. `--fresh` rereads job pages instead of using saved copies. |
| `push` | Sends the new strong fits of the last scan to career-ops. `--min 60` lowers the bar, `--dry` only lists them. |
| `rescore` | Applies a changed profile to the last scan's fits and rewrites the report, without reading any site. The quick way to tune the profile. A job that was found on two sites is scored again from the kept link's own text, so a few such jobs can move by some points until the next scan. |
| `sources` | Lists the sources and how each did in the last scan. |
| `explain <text>` | Shows how jobs matching a title, company or link were scored. |
| `discover "Name" [url] [--add] [--cz]` | Works out how a company's jobs can be read, starting from its homepage or careers page, and prints its entry (or, with `--add`, writes it into your `companies.yml`). When it cannot be read, it says why. |
| `init` | Creates your settings files. Existing ones are left alone. |
| `doctor` | Shows where the code and your data are and what is set up. |

Every command is run as `node radar.mjs <command>`. A scan takes about 3
minutes; LinkedIn, when you turn it on, adds about 5.

## What gets shown

Each job gets a score from 0 to 100:

1. **Track**: the best of three, each made of a title rule plus evidence in the
   description. Flutter / mobile, agentic / AI-native engineering, product / growth.
2. **Place of work**: Prague, remote from Czechia, or remote across Europe add
   points. An office elsewhere, or a remote job tied to another region, drops the
   job. "Remote, Germany" stays in, with a penalty and a note to check.
3. **Freshness, seniority, pay**: small adjustments.
4. **Penalties**: native-only iOS/Android, ML-heavy or Python-first AI roles,
   Java/.NET/PHP stacks, many more years asked than you have, another language
   required.

65 and up is a strong fit, 50 to 64 is worth a look. Both are in the report with
the reasons ("Why") and the doubts ("Check"). Only strong fits are pushed.

All of it is set in the profile: the terms, the points, the thresholds, the
title words that drop a job outright. The built-in one is
[`config/profile.yml`](config/profile.yml).

A job is **new** when neither an earlier radar report nor career-ops (inbox,
scan history, tracker) has it. The same role found on several sites is reported
once, with the other links listed.

## Sources

| Source | How it is read |
|---|---|
| StartupJobs.cz | The site's own search API; the whole board (a few hundred offers). |
| Jobs.cz | Keyword searches of the listing pages, then each job page's structured data. |
| Cocuma | Every page of the board (its keyword search does not filter). |
| Workable job search | One query across every company hosting jobs on Workable. |
| Himalayas, Remotive, We Work Remotely | Remote boards with the region each job accepts. |
| HN Who is hiring | The current monthly thread, searched by keyword. |
| Company career sites | Greenhouse, Lever, Ashby, Recruitee, Teamtailor, Workable, SmartRecruiters, Personio, BambooHR and Breezy boards; companies' own careers pages; job widgets embedded from other services (Tribee, Recruitis); and, for a site that cannot be read, the company's own ads on Jobs.cz. See "Company sites" below. |
| LinkedIn (off by default) | The search that signed-out visitors see: no account, one request every 20 seconds, searches and opened jobs capped. See "Reading politely" before you turn it on. |

Searches, keywords, pacing and limits are in [`config/sources.yml`](config/sources.yml).

The company list grows by itself. For each new strong fit found on a board or
search source, the radar looks for that company's own hiring-system board and
keeps it only when the same job is listed there (so a company that merely shares
the name is never picked up). From then on the whole board is read directly.
These additions are kept in `state/companies-auto.json` in your data folder; move
the ones you want to keep into your `companies.yml`.

## Company sites

About 80 companies are built in ([`config/companies.yml`](config/companies.yml)):
Czech product companies, studios and agencies, and international companies that
build with Flutter or hire remotely in Europe. Add one of your own with its
homepage or careers page; the radar finds the rest:

```bash
node radar.mjs discover "Etnetera" https://www.etnetera.cz --add --cz
```

For many at once, put one `Name | URL | cz` per line in a text file:

```bash
node radar.mjs discover --file companies.txt --add
```

It walks the site the way a person would: homepage, careers page, the "open
positions" list behind it. On each page it looks for, in this order:

1. **A hiring system** the site runs on (Greenhouse, Ashby, Teamtailor and the
   others above). Its own data is the cleanest source, so that wins.
2. **Job links** in the page. A link counts when it sits in a job-like place and
   reads like a job; links of the same kind next to it are then taken too. Where
   the link is only a button ("More", "I am in!"), the title comes from the card
   around it, and where there is no text at all, from the words in the address
   until the job page itself is read.
3. **Job data** the page carries or downloads, for lists drawn by JavaScript.
4. **An embedded widget** from another service: the widget is read directly.

Pages built by JavaScript are loaded in a headless browser (`render: true` in
the entry). A careers page that says it has nothing open, or an empty board, is
still added, so the company is watched until something appears.

What cannot be read, and what `discover` then says:

| Cause | What happens |
|---|---|
| The site answers automated requests with a captcha or a challenge page | It is not read, and nothing is done to get around the check. If the company publishes its own ads on Jobs.cz, those are read instead (`ats: jobscz`). |
| The site has no careers page at all | Nothing to read. Its jobs can still arrive through the job boards. |
| Openings appear only after clicking through the page | Not read. Add a direct link to the list if the site has one. |
| The board was matched by the company's name alone | Shown, never added automatically: check it is the right company first. |

An entry is one of:

```yaml
- { name: "Apify", ats: ashby, slug: "apify", country: cz }      # a hiring system's board
- { name: "Etnetera", url: "https://www.etnetera.cz/prace-u-nas", country: cz, location: "Praha" }
- { name: "Productboard", url: "https://…/open-positions/", render: true }   # needs the browser
- { name: "Alza", ats: jobscz, slug: "Alza", country: cz }       # its ads on Jobs.cz
```

`country: cz` treats a job without a stated place as being in Czechia;
`location:` is used for every job from that page; `link_pattern:` (a regular
expression) overrides the automatic pick of job links.

The headless browser is Playwright. It is not installed with job-radar: the
radar uses it when you install it in the code folder
(`npm i playwright && npx playwright install chromium`) or borrows it from
career-ops when that is installed. Without it, companies marked `render: true`
are skipped with a note.

## Reading politely

- Requests to one site run one at a time with a pause between them
  (`pacing` in `sources.yml`), and a "slow down" answer makes the radar wait
  longer instead of retrying harder. Run one scan at a time.
- A site that answers with a captcha or a challenge page is not read. Nothing
  here solves or avoids such checks. Requests carry an ordinary browser's
  User-Agent and nothing else is done to look like a person.
- Saved job pages are reused for 14 days, so a job's page is fetched once.
- LinkedIn's terms do not allow automated reading. That source is off unless
  you turn it on in your `sources.yml`, and it is kept very slow. Whether to use
  it is your decision.
- You are responsible for how you use this, including the terms of the sites you
  read. It is meant for one person's own job search, not for collecting listings
  in bulk.

## Files

```
radar.mjs               checks the setup, then starts src/cli.mjs
src/cli.mjs             the commands
src/sources/            one file per source      src/match.mjs      the scoring
src/pagejobs.mjs        reading jobs out of a careers page
src/discover.mjs        finding a company's jobs from its homepage
src/config.mjs          built-in settings with yours laid over them
config/                 the built-in settings    templates/         starting points for yours
skills/radar/           what Claude follows when job-radar runs as a plugin
test/                   parser, scoring and settings tests
```

## career-ops

Optional. When career-ops is installed, the radar reads its data folder
(`~/career-ops-data`, or `CAREER_OPS_DATA_DIR`) to know what is already there,
and `push` writes only through career-ops' own inbox writer, so its file
formats, locking and duplicate checks stay in charge. A pushed job lands in
`data/pipeline.md` like any scanned one, with the radar's score in its note:

```
- [ ] https://… | Example Labs | Senior Flutter Developer | Praha | posted: 2026-11-03 | note: radar 85 · Flutter / mobile
```

Without career-ops, everything except `push` works the same.

## When something breaks

- **"not set up in this folder yet"**: run the `npm install` line it prints.
  As a plugin this is needed once after installing and once after each update.
- **A source fails**: the scan carries on and the report's Sources table says
  which one and why. Sites change their pages; the reader for each is one short
  file in `src/sources/`.
- **LinkedIn stops early**: it is rate limiting, or its time budget
  (`max_minutes`) ran out. Results so far are kept. Jobs whose page was not
  opened are scored on the title alone and marked "description not read"; saved
  pages are reused for 14 days, so each scan fills in more of them.
- **A company shows no jobs**: `node radar.mjs discover "Name" <its address>`
  retraces the way to its jobs and says where it stops.
- **A good job is missing**: `node radar.mjs explain <part of its title>`. If it
  is not listed it was dropped or never found; check `exclude_title` in the
  profile and the searches in `sources.yml`.
- **Too much noise**: raise `thresholds`, or add the offending word with
  `exclude_title+` or a `title_penalties+` rule in your profile.

## Working on it

```bash
npm test     # parser, scoring and settings tests
```

The pages in `test/fixtures/` copy the markup of the sites they are named after;
the jobs and companies in them are made up. The plugin file sets no version, so
each commit on the main branch counts as a new version and plugin users get it
with their next plugin update.

## License

MIT. See [LICENSE](LICENSE).
