/**
 * End-to-end smoke test against the built app in a real browser.
 *
 * Deliberately not part of `npm test`, and playwright is deliberately not a dependency — the
 * brief asks for the engine and parser to be tested and the UI not to be, and this is neither a
 * unit test nor a substitute for one.
 *
 * It exists because it caught a fatal bug that 345 passing unit tests could not: i18next was being
 * initialised in an effect while `useTranslation` ran during render, so react-i18next threw from
 * its own effect and the entire tree failed to mount. The page was blank. Nothing short of loading
 * it in a browser would have found that.
 *
 *   npm run build
 *   npx vite preview --port 4173 &
 *   npx playwright install chromium      # once
 *   node scripts/smoke.mjs
 *
 * Env: BASE (default http://localhost:4173), SHOTS (screenshot dir), CHROMIUM (browser path).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = process.env.SHOTS ?? './smoke-shots';
mkdirSync(OUT, { recursive: true });

const problems = [];
const log = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) problems.push(label + (detail ? ': ' + detail : ''));
};

// CHROMIUM lets a preinstalled binary be pointed at; otherwise playwright finds its own.
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // iPhone-ish
  locale: 'en-GB',
  timezoneId: 'Asia/Jerusalem',
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// ---------------------------------------------------------------- load
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
log((await page.title()) === 'ReMind', 'page loads with the right title', await page.title());
await page.screenshot({ path: `${OUT}/01-launch.png` });

// Capture field focused on mount — the "launch to capture" requirement.
const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
log(focusedTag === 'TEXTAREA', 'capture field is focused on mount', `activeElement=${focusedTag}`);

// ---------------------------------------------------------------- confident capture
await page.fill('.capture__input', 'Dinner with Alex tomorrow at 8pm');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);

const followup = (await page.locator('.followup').first().textContent()) ?? '';
log(/Added to your calendar/i.test(followup), 'confident capture creates an event silently', followup.trim().slice(0, 60));
log(await page.locator('.followup button', { hasText: 'Undo' }).isVisible(), 'undo is offered');
await page.screenshot({ path: `${OUT}/02-capture-created.png` });

const todayText = (await page.locator('.item-list').textContent().catch(() => '')) ?? '';
log(true, 'today list state after capture', todayText.trim().slice(0, 80) || '(empty — event is tomorrow)');

// The field must clear after saving.
log((await page.inputValue('.capture__input')) === '', 'field clears after save');

// ---------------------------------------------------------------- actionable capture
await page.fill('.capture__input', 'Call Dani');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const offerText = (await page.locator('.followup').first().textContent()) ?? '';
log(/Remind you about this/i.test(offerText), 'actionable note offers a reminder', offerText.trim().slice(0, 70));
const offerButtons = await page.locator('.followup button').allTextContents();
log(offerButtons.length >= 2, 'reminder presets are offered', offerButtons.join(' | '));
await page.screenshot({ path: `${OUT}/03-actionable.png` });

// Take one of the presets and confirm a trigger lands in Today.
await page.locator('.followup button', { hasText: 'In an hour' }).click();
await page.waitForTimeout(900);
const afterSet = (await page.locator('.followup').first().textContent()) ?? '';
log(/Reminder set/i.test(afterSet), 'choosing a preset sets the reminder', afterSet.trim().slice(0, 60));
const todayAfter = (await page.locator('.item-list').textContent().catch(() => '')) ?? '';
log(/Call Dani/.test(todayAfter), 'reminder appears in Today', todayAfter.trim().slice(0, 80));
  const weekCells = await page.locator('.week-day').count();
  log(weekCells === 7, 'week-at-a-glance shows seven days', `${weekCells} cells`);
  const overview = await page.locator('.month-grid--compact .month-grid__day').count();
  log(overview === 42, 'calendar overview renders the month', `${overview} cells`);
await page.screenshot({ path: `${OUT}/04-today.png` });

// ---------------------------------------------------------------- uncertain capture
await page.fill('.capture__input', 'Lunch with Maya tomorrow');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const sheet = (await page.locator('.followup--sheet').first().textContent()) ?? '';
log(/Is this right/i.test(sheet), 'uncertain capture asks first', sheet.trim().slice(0, 70));
await page.screenshot({ path: `${OUT}/05-proposal.png` });
await page.locator('.followup button', { hasText: 'Just keep the note' }).click();
await page.waitForTimeout(400);

// ---------------------------------------------------------------- calendar
await page.locator('.tabbar__tab', { hasText: 'Calendar' }).click();
await page.waitForTimeout(900);
const dayCells = await page.locator('.month-grid__day').count();
log(dayCells === 42, 'month grid renders six weeks', `${dayCells} cells`);
log(await page.locator(".month-grid__day[data-today='true']").count() === 1, 'today is marked');
const dots = await page.locator('.month-grid__dot').count();
log(dots >= 1, 'the created event shows as a dot on its day', `${dots} dots`);
await page.screenshot({ path: `${OUT}/06-calendar.png` });

// Open the day with the event.
await page.locator(".month-grid__day", { has: page.locator('.month-grid__dot') }).first().click();
await page.waitForTimeout(600);
const dayList = (await page.locator('.day-detail').textContent()) ?? '';
log(/Dinner with Alex/.test(dayList), 'day detail lists the event', dayList.trim().slice(0, 90));
await page.screenshot({ path: `${OUT}/07-day-detail.png` });

// ---------------------------------------------------------------- search
await page.locator('.tabbar__tab', { hasText: 'Search' }).click();
await page.waitForTimeout(500);
await page.fill('input[type="search"]', 'alex');
await page.waitForTimeout(900);
const results = (await page.locator('.item-list').textContent().catch(() => '')) ?? '';
log(/Dinner with Alex tomorrow at 8pm/.test(results), 'search finds the entry by its original words', results.trim().slice(0, 90));
await page.screenshot({ path: `${OUT}/08-search.png` });

// ---------------------------------------------------------------- people
await page.locator('.tabbar__tab', { hasText: 'People' }).click();
await page.waitForTimeout(500);
log(/Nobody yet/i.test((await page.locator('main').textContent()) ?? ''), 'people starts empty');

// Add someone with an alias and a cadence. The alias is the knob that makes mention matching
// work when a note uses a nickname.
await page.locator('button', { hasText: 'Add someone' }).click();
await page.waitForTimeout(300);
await page.fill('.field__input >> nth=0', 'Alex Cohen');
await page.fill('.field__input >> nth=1', 'Alex');
await page.locator('button', { hasText: 'Every 2 weeks' }).click();
await page.locator('button', { hasText: 'Save' }).click();
await page.waitForTimeout(900);

const peopleList = (await page.locator('main').textContent()) ?? '';
log(/Alex Cohen/.test(peopleList), 'the person appears in the list', peopleList.trim().slice(0, 80));
log(/Due in/i.test(peopleList), 'the cadence status is shown', peopleList.trim().slice(0, 120));
await page.screenshot({ path: `${OUT}/12-people-list.png` });

// Open the detail view.
await page.locator('.person-row').first().click();
await page.waitForTimeout(700);
const detail = (await page.locator('main').textContent()) ?? '';
log(/What you know/i.test(detail), 'person detail renders');
// The alias matches the earlier capture "Dinner with Alex tomorrow at 8pm", which was written
// before this person existed — the case derived mentions exist to handle.
log(/Dinner with Alex/.test(detail), 'notes written before the person was added are found', detail.trim().slice(0, 140));
await page.screenshot({ path: `${OUT}/13-person-detail.png` });

// Record a fact, then confirm it lands with its kind.
await page.fill('.followup .field__input', 'drinks coffee black');
await page.locator('.followup button', { hasText: 'Preference' }).click();
await page.locator('.followup button', { hasText: 'Save' }).click();
await page.waitForTimeout(800);
const withFact = (await page.locator('main').textContent()) ?? '';
log(/drinks coffee black/.test(withFact), 'the fact is recorded', withFact.trim().slice(0, 120));
log(await page.locator('.fact-kind').first().isVisible(), 'the fact shows its kind');
await page.screenshot({ path: `${OUT}/14-person-fact.png` });

// Logging a catch-up must move the cadence status off "due".
await page.locator('button', { hasText: 'We caught up' }).click();
await page.waitForTimeout(900);
log(/Last catch-up/i.test((await page.locator('main').textContent()) ?? ''), 'a catch-up is recorded');

// ---------------------------------------------------------------- meeting briefing
// The briefing card only covers the rest of *today*, and the dinner captured earlier is
// tomorrow — so an event later today has to exist for this path to be exercised at all rather
// than silently skipped. Scheduled at 23:00 local so it stays ahead of "now" whenever this runs.
await page.locator('.tabbar__tab', { hasText: 'Calendar' }).click();
await page.waitForTimeout(700);
await page.locator(".month-grid__day[data-today='true']").click();
await page.locator('button', { hasText: 'Add event' }).click();
await page.waitForTimeout(300);

const todayLocal = await page.evaluate(() =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()),
);
await page.fill('.followup--sheet .field__input >> nth=0', 'Coffee with Alex');
await page.fill(".followup--sheet input[type='datetime-local'] >> nth=0", `${todayLocal}T23:00`);
await page.locator('.followup--sheet button', { hasText: 'Save' }).click();
await page.waitForTimeout(900);

await page.locator('.tabbar__tab', { hasText: 'Today' }).click();
await page.waitForTimeout(1000);
const today = (await page.locator('main').textContent()) ?? '';
log(/Before you meet/i.test(today), 'the briefing card appears for a meeting later today', today.trim().slice(0, 60));
log(
  /drinks coffee black/.test(today),
  'the briefing surfaces the fact about whoever the meeting is with',
);
await page.screenshot({ path: `${OUT}/15-today-briefing.png` });

// ---------------------------------------------------------------- location pins
// Geolocation is granted and stubbed to a fixed point, because the whole feature is a comparison
// between two coordinates and the interesting question is whether the round trip through IndexedDB
// and back onto the screen works.
await context.grantPermissions(['geolocation']);
await context.setGeolocation({ latitude: 32.08, longitude: 34.78, accuracy: 20 });

await page.locator('.tabbar__tab', { hasText: 'Today' }).click();
await page.waitForTimeout(600);
const pinnable = await page.locator('button', { hasText: 'Pin here' }).count();
log(pinnable > 0, 'unscheduled notes offer a pin', `${pinnable} offered`);

await page.locator('button', { hasText: 'Pin here' }).first().click();
await page.waitForTimeout(1200);
const pinnedText = (await page.locator('main').textContent()) ?? '';
log(/Near you now/i.test(pinnedText), 'a pinned note surfaces while standing on it', pinnedText.trim().slice(0, 60));
log(/right here/i.test(pinnedText), 'distance reads as "right here" on the spot');
await page.screenshot({ path: `${OUT}/17-nearby.png` });

// A pin must never reach the push backend: with no time attached it cannot fire, so it is not
// scheduled, and an unscheduled trigger is never mirrored. This is the privacy claim for places.
const pinRow = await page.evaluate(async () => {
  const open = indexedDB.open('remind');
  const dbh = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
  const rows = await new Promise((res, rej) => {
    const req = dbh.transaction('triggers').objectStore('triggers').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  const pins = rows.filter((r) => r.location !== null);
  return pins.map((p) => ({ nextFireAt: p.nextFireAt, syncedFireAt: p.syncedFireAt, active: p.active }));
});
log(pinRow.length === 1, 'exactly one pin was stored', JSON.stringify(pinRow));
log(
  pinRow[0]?.nextFireAt === null && pinRow[0]?.syncedFireAt === null && pinRow[0]?.active === 1,
  'the pin is active but unscheduled, so it is never mirrored to the backend',
  JSON.stringify(pinRow[0]),
);

// Walk far away: the card must disappear rather than persist from the earlier read.
await context.setGeolocation({ latitude: 31.7683, longitude: 35.2137, accuracy: 20 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
log(
  !/Near you now/i.test((await page.locator('main').textContent()) ?? ''),
  'the pin does not surface from 50 km away',
);
await page.screenshot({ path: `${OUT}/18-nearby-away.png` });

// ---------------------------------------------------------------- settings + RTL
await page.locator('.tabbar__tab', { hasText: 'Settings' }).click();
await page.waitForTimeout(700);
const settingsText = (await page.locator('.settings').textContent()) ?? '';
log(/Notifications/i.test(settingsText), 'settings renders');
log(/Quiet hours/i.test(settingsText), 'quiet hours controls present');
log(/Backup/i.test(settingsText), 'backup controls present');
await page.screenshot({ path: `${OUT}/09-settings.png` });

// Switch to Hebrew and confirm the document flips.
await page.selectOption('.settings select', 'he');
await page.waitForTimeout(900);
const dir = await page.evaluate(() => document.documentElement.dir);
const lang = await page.evaluate(() => document.documentElement.lang);
log(dir === 'rtl', 'switching to Hebrew sets dir=rtl', `dir=${dir} lang=${lang}`);
const heText = (await page.locator('.tabbar').textContent()) ?? '';
log(/הגדרות/.test(heText), 'tab labels are translated', heText.trim());
await page.screenshot({ path: `${OUT}/10-hebrew-rtl.png` });

// The People screen in RTL. Its rows mix a Latin name with Hebrew status text, which is exactly
// where a layout built on physical rather than logical properties falls apart.
await page.locator('.tabbar__tab', { hasText: 'אנשים' }).click();
await page.waitForTimeout(600);
const hePeople = (await page.locator('main').textContent()) ?? '';
log(/Alex Cohen/.test(hePeople), 'people renders under RTL', hePeople.trim().slice(0, 70));
await page.locator('.person-row').first().click();
await page.waitForTimeout(700);
log(
  /מה שאתה יודע/.test((await page.locator('main').textContent()) ?? ''),
  'person detail is translated',
);
await page.screenshot({ path: `${OUT}/16-hebrew-people.png` });

// Hebrew capture, in RTL, end to end.
await page.locator('.tabbar__tab', { hasText: 'היום' }).click();
await page.waitForTimeout(500);
await page.fill('.capture__input', 'ארוחת ערב עם דני מחר בשמונה בערב');
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
const heFollowup = (await page.locator('.followup').first().textContent()) ?? '';
log(/נוסף ליומן/.test(heFollowup), 'Hebrew capture creates an event silently', heFollowup.trim().slice(0, 60));
await page.screenshot({ path: `${OUT}/11-hebrew-capture.png` });

// ---------------------------------------------------------------- service worker
const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? { scope: reg.scope, active: !!reg.active, state: reg.active?.state } : null;
});
log(swState?.active === true, 'service worker registered and active', JSON.stringify(swState));

// ---------------------------------------------------------------- console
log(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 4).join(' || '));

await browser.close();

console.log('\n' + '='.repeat(60));
if (problems.length === 0) console.log('ALL CHECKS PASSED');
else {
  console.log(`${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log('  - ' + p);
}
process.exit(problems.length === 0 ? 0 : 1);
