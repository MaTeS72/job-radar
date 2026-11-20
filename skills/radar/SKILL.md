---
name: radar
description: Scans job boards and company career sites for new openings that fit the user's search profile, and manages what is watched. Use when the user says "scan for jobs", "any new jobs?", "run the job radar", "add this company to the radar", "why was this job not shown?", or wants to change what counts as a fit.
argument-hint: "[scan | sources | add <company> <address> | explain <text> | setup]"
---

# Job radar

The scanner is a Node program that comes with this plugin. It calls no AI model
and nothing is paid for: it reads public job listings at a slow, fixed pace and
scores them with keyword rules.

<request>$ARGUMENTS</request>

With no request, run a scan (step 1). Every command is run like this:

```bash
node "${CLAUDE_PLUGIN_ROOT}/radar.mjs" <command>
```

## 0. Check the setup, once per session

```bash
node "${CLAUDE_PLUGIN_ROOT}/radar.mjs" doctor
```

- If it answers "not set up in this folder yet", run the `npm install` line it
  prints and run `doctor` again. That is needed once after installing and once
  after each update of the plugin. It needs Node 20 or newer.
- Note the **Your data** folder it prints (`~/job-radar-data` unless
  `JOB_RADAR_HOME` is set). The user's own settings (`config/`), the reports
  (`out/`) and the record of what was already reported (`state/`) live there.
  Keep nothing of the user's in the plugin folder: an update replaces it.
- If `doctor` shows "built-in only" for `profile.yml`, this is a first use. Run
  `init`, then tell the user in two sentences what the built-in profile looks
  for (senior Flutter and mobile, agentic and AI-native engineering, product
  roles; Prague, remote from Czechia, or remote across Europe) and ask whether
  that is their search. Write their years of experience, and their pay target
  if they give one, into `profile.yml` in their data folder. If their search is
  different, change the profile with them first (step 3).

## 1. Scan

```bash
node "${CLAUDE_PLUGIN_ROOT}/radar.mjs" scan --verbose
```

A scan takes about 3 minutes, about 8 with LinkedIn on. Run it in the
background if your shell tool would time out sooner. Run one scan at a time:
the pacing that keeps the scanner polite only holds for a single run.

Then read `out/latest.md` in the data folder and tell the user:

- each **new strong fit**: score, title, company, place, pay if stated, the
  link, the "Why" in a few words and every "Check" note;
- how many are **worth a look**, listing them only when there are few or when
  asked;
- any source that failed, one line each.

Do not paste the whole report, and add nothing that is not in it. A job marked
"description not read" was scored on its title alone: say so.

## 2. Other requests

| The user wants | Command |
|---|---|
| A company watched | `discover "Name" <homepage or careers page> --add`, with `--cz` for a Czech company. When it answers that the company cannot be read, pass the reason on. |
| To know why a job got its score, or why it is missing | `explain <part of the title, the company, or the link>` |
| Which sources are on, how the last scan went | `sources` |
| The strong fits in career-ops | `push`, only when asked. `push --dry` shows what would be sent. |

## 3. Changing what counts as a fit

Change only the user's own files in the `config/` folder of their data folder:
`profile.yml` (what is a fit), `sources.yml` (which sources and searches) and
`companies.yml` (career sites of their own). Each holds only what should differ
from the built-in file of the same name in `${CLAUDE_PLUGIN_ROOT}/config/`.
Read the built-in file first to see the keys and their current values.

- A value replaces the built-in value. A map is merged key by key.
- A list replaces the built-in list, unless the key is written `name+:` (add
  these entries) or `name-:` (take these entries out).
- In `companies.yml`, `companies:` adds career sites and `skip:` names built-in
  companies to leave out.

After a profile change run `rescore`: it applies the change to the last scan
without reading any site again. Tell the user what moved in or out.

`${CLAUDE_PLUGIN_ROOT}/README.md` explains the scoring, each source, and what to
do when something breaks.

## Rules

- Reading only. Never apply for a job, fill in a form or send a message for the
  user.
- When a site answers with a captcha or a challenge page, the scanner stops
  there on purpose. Do not try another way in: no browser tool, no other fetch
  tool, no changed headers.
- LinkedIn is off unless the user turned it on in their `sources.yml`. Turn it
  on only when they ask, and tell them first that LinkedIn's terms do not allow
  automated reading and that the choice is theirs.
- Do not shorten the pauses between requests (`pacing` in `sources.yml`).
