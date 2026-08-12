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
