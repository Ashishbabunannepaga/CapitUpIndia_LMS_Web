# Switching the AI features to OpenAI

The AI features (lead intake, visiting card scanning, follow-up writer and
import column mapping) now run on OpenAI instead of Gemini. The app reads one
Worker secret, `OPENAI_API_KEY`. Without it, everything still works with the
offline fallbacks (basic extraction, standard follow-up drafts), and card
scanning says AI is unavailable.

Steps marked **👤 You** need you in a browser. Nobody else should handle the
key: never paste it into chat, email, a commit or a screenshot.

## 1. 👤 You: get an OpenAI API key (5 minutes)

1. Go to <https://platform.openai.com> and sign in.
2. **Billing**: add credit (5 USD is plenty to start). The models the app uses
   (`gpt-5.6-luna`, with `gpt-5.6-terra` as backup) are not available on the
   free tier, so without credit every AI call fails with "out of credit".
3. **Projects**: create a project called `CapitUp LMS`, so this key has its own
   usage and budget.
4. In that project, open **Limits** and set a monthly budget (for example
   20 USD) so a mistake can never run up a large bill.
5. Open **API keys** > **Create new secret key**:
   - Owned by: the `CapitUp LMS` project
   - Name: `capitup-lms-web`
   - Permissions: **Restricted**, with **Model capabilities** (Chat
     completions) set to **Write** and everything else **None**. If you don't
     see those options, **All** works too.
6. Copy the key (it starts with `sk-`). OpenAI shows it only once. Go straight
   to step 2; don't save it anywhere else.

## 2. 👤 You: put the key into Cloudflare (2 minutes)

1. Cloudflare dashboard > **Workers & Pages** > `capitup-lms-web` >
   **Settings** > **Variables and Secrets** > **Add**.
2. **Type: Secret** (not Text: plain text variables are wiped on every deploy).
3. **Variable name**: `OPENAI_API_KEY` (exactly this, all capitals).
4. **Value**: paste the key. Click **Deploy**.

You can do this before or after merging the pull request: today's code simply
ignores the new secret until the new code is live.

## 3. 👤 You: merge the pull request

Merging to `main` makes Workers Builds rebuild and deploy the app (about 3
minutes). Nothing changes in the database: OpenAI's prices are added to the
pricing table automatically the first time they are needed.

## 4. 👤 You: test it (3 minutes)

1. Sign in, open **Intake**, paste:
   `Spoke to Rajesh (Director) at Renee Systems, 9876500011, group health renewal 15 March, current insurer ICICI`
   and extract. The fields fill in and the page does **not** say "Basic
   extraction filled what it could".
2. Open a lead > **Follow-up** > pick a tone. A short message appears in a few
   seconds.
3. Scan a visiting card on **Intake** (photo upload).
4. Open **AI Usage** (admin). The three calls are listed with model
   `gpt-5.6-luna` and a rupee cost. While you're there, check the
   **USD to INR** rate is current; every call is priced with it.

If something says AI is unavailable, the message tells you which part to fix:

| Message | What to do |
| --- | --- |
| "OPENAI_API_KEY is missing" | The secret isn't there, is named differently, or the deploy hasn't finished. Check step 2. |
| "The OpenAI key was refused" | The key was mistyped, revoked, or has no Chat completions permission. Make a new one (step 1.5) and replace the secret. |
| "The OpenAI account is out of credit" | Add credit in OpenAI **Billing**, or raise the project budget. |
| "The AI service is busy" | OpenAI is rate limiting; try again in a minute. |
| "could not process this request" | Look in Cloudflare > the Worker > **Logs** for lines starting `AI model gpt-5.6-luna failed` and send me the text (not the key). |

## 5. 👤 You (optional): tidy up Gemini

Once step 4 works: delete the `GEMINI_API_KEY` secret from the Worker, and
delete the key in Google AI Studio (<https://aistudio.google.com/apikey>).
Old Gemini rows stay on the AI Usage page as history.

## What changed for speed

- **Faster model, no "thinking" for simple jobs.** Intake, mapping and
  follow-ups use `gpt-5.6-luna` with reasoning switched off; card scanning
  uses a little reasoning because photos are messy. Answers are capped in
  length, and a stuck model is abandoned after 25 seconds (was 45) in favour
  of the backup model.
- **Fails fast.** A wrong key or an empty account stops at the first try
  instead of waiting through every backup model.
- **Usage logging after the reply.** The cost record is written after the
  answer is sent, so it no longer delays the user.
- **Follow-ups** load the lead and its notes at the same time.
- **Smaller app.** Dropping Google's SDK (OpenAI is called with plain `fetch`)
  cut the Worker from 2.52 MB to 2.21 MB gzipped (9.0 MB to 7.7 MB raw), so
  fresh Workers start faster.
- **Worker runs next to the database** (`placement: smart` in
  `wrangler.jsonc`). Every page makes several database queries one after
  another; from India each one is a round trip to the D1 database. Cloudflare
  now runs the Worker beside D1, so each query is a short local hop. It needs
  up to 15 minutes of traffic after the deploy to take effect. To check, open
  the browser's developer tools > Network, click a page request and look for
  the `cf-placement` response header: `remote-…` means it is working.
- **Click feedback.** A thin gold bar fills under a sidebar link while its
  page loads, so a click always shows it registered.

Tried and dropped: full-page loading skeletons. Locally they made each page
appear about 250 ms *later*, because React holds a skeleton on screen for at
least 300 ms, and they changed the "not found" answer for a lead an agent
may not open.

## Where things live

- `src/lib/ai/models.ts`: which models each feature uses, in fallback order,
  their default prices (USD per million tokens) and the timeouts. Change a
  model here; add its price here too.
- `src/lib/ai/client.ts`: the one entry point features call (`generate`),
  with rate limiting, fallback and cost logging.
- `src/lib/ai/openai.ts`: the OpenAI request itself. Data is sent with
  `store: false`; OpenAI does not train on API data by default.
- Prices admins edit on **AI Usage** win over the defaults in `models.ts`.
