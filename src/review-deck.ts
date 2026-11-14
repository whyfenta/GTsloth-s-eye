import { closed, done, tally, type Catalog, type Item, type Vote, type Votes } from './review-model';
import { bossSlot, candidate, dayKey, decidedOn, firstOn, goalOf, GOALS, learnedClasses, nextCard, reachedBy, teamWeek, weekDays, weekStart } from './review-progress';

// The review page's card mode, for phones: one card at a time and a small stack a day instead of the whole list. Swipe right
// (or 同意) agrees, swipe left (or 稍後) puts the card back for later without a word; 有意見 opens the card's own boxes for
// 不同意 or 其他意見. The cards, the votes and the saving are the list's own (src/review.ts); this keeps only conveniences in
// the browser: the day's goal, the cards put back today, and the days a decision was made.

export interface DeckHost {
  /** Every item, in the list's order. */
  items(): Item[];
  mine(): Votes;
  me(): string;
  /** Everyone's votes on an item, AI pre-reviews and this reviewer's own included. */
  allVotesOn(id: string): Record<string, Vote>;
  /** The pharmacists' votes on an item (this reviewer's own included): these count. */
  teamVotesOn(id: string): Record<string, Vote>;
  hasPre(item: Item): boolean;
  quorum(): number;
  atc(): Catalog['atc'];
  buildCard(item: Item): HTMLElement;
  updateCard(item: Item): void;
  /** False (and the name box asks for a name) when a decision cannot be made yet. */
  ready(): boolean;
  agree(item: Item): void;
  /** Takes back a decision made here: the vote goes back to what it was, as a new change. */
  restore(item: Item, before: Vote | undefined): void;
}

const KEYS = { goal: 'gtsloth-review-goal', skip: 'gtsloth-review-skip', days: 'gtsloth-review-days', stacks: 'gtsloth-review-stacks' };
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
/** How long a card is shown before a swipe can agree: a glance is not a review. A challenge card waits longer. */
const LOOK = 1200, LOOK_BOSS = 3000;
const TOAST = 5000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(cls: string, text: string, click: () => void) {
  const node = el('button', cls, text);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}
const read = <T>(key: string): T | undefined => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; } catch { return undefined; } };
const keep = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a convenience only */ } };
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const today = () => dayKey(new Date());

export function createDeck(host: DeckHost, box: HTMLElement) {
  let goal = goalOf(read<number>(KEYS.goal));
  const skipSaved = read<{ date: string; ids: string[] }>(KEYS.skip);
  const skipped = new Set(skipSaved?.date === today() ? skipSaved.ids : []);
  let current: Item | undefined, boss = false, shownAt = 0;
  let state: 'card' | 'done' | 'empty' = 'empty', resting = false;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const todayBox = el('div', 'today');
  const status = el('p', 'status');
  status.id = 'deck-status'; status.setAttribute('role', 'status');
  const stage = el('div', 'stage');
  const bar = el('div', 'deckbar');
  const toast = el('div', 'toast');
  toast.setAttribute('role', 'status'); toast.hidden = true;
  const intro = el('p', 'deckintro', '一次一張：看完右滑同意，還不想決定就左滑放著；不同意或有其他意見，按「有意見」寫下來。每天一小疊就好。');
  box.replaceChildren(intro, todayBox, status, stage, bar, toast);

  const stacks = () => { const saved = read<{ date: string; n: number }>(KEYS.stacks); return saved?.date === today() && saved.n > 1 ? saved.n : 1; };
  const decidedToday = () => decidedOn(host.mine(), today());
  const logDay = () => { const days = read<string[]>(KEYS.days) ?? []; if (!days.includes(today())) keep(KEYS.days, [...days, today()].slice(-14)); };
  const saveSkip = () => keep(KEYS.skip, { date: today(), ids: [...skipped] });
  const othersOn = (id: string) => { const votes = { ...host.teamVotesOn(id) }; delete votes[host.me()]; return votes; };

  function renderToday() {
    const decided = decidedToday().length, n = stacks();
    const inStack = Math.max(0, Math.min(goal, decided - goal * (n - 1)));
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 64 64'); ring.setAttribute('class', 'ring'); ring.setAttribute('aria-hidden', 'true');
    const length = 2 * Math.PI * 27;
    ring.innerHTML = `<circle class="track" cx="32" cy="32" r="27"/><circle class="fill" cx="32" cy="32" r="27" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length * (1 - inStack / goal)).toFixed(1)}" transform="rotate(-90 32 32)"/>`
      + `<text x="32" y="33">${inStack}／${goal}</text>`;
    const head = el('p', 'todayhead', n > 1 ? `今天 ${decided} 張・加碼第 ${n - 1} 疊` : decided >= goal ? `今天的 ${goal} 張完成了` : `今天 ${decided}／${goal} 張`);
    const week = el('div', 'week');
    week.setAttribute('aria-label', '本週有審的日子');
    const days = weekDays(host.mine(), read<string[]>(KEYS.days) ?? [], new Date()), now = (new Date().getDay() + 6) % 7;
    days.forEach((on, n) => { const dot = el('span', `${on ? 'on' : ''}${n === now ? ' now' : ''}`.trim(), WEEK[n]); dot.title = on ? `星期${WEEK[n]}有審` : `星期${WEEK[n]}`; week.append(dot); });
    const read_ = Object.values(host.mine()).filter(vote => vote.d).length;
    let pushed = 0, first = 0;
    for (const item of host.items()) {
      if (!host.mine()[item.id]?.d) continue;
      if (reachedBy(item, host.teamVotesOn(item.id), host.quorum(), host.me())) pushed++;
      if (firstOn(host.allVotesOn(item.id), host.me())) first++;
    }
    const sum = [`你已讀過 ${read_} 條`, pushed ? `推進 ${pushed} 條達門檻` : '', first ? `當過第一位 ${first} 次` : ''].filter(Boolean).join('・');
    const goals = el('div', 'goals');
    goals.append(el('span', '', '每天'));
    for (const value of GOALS) {
      const chip = button('chipbtn', `${value}`, () => setGoal(value));
      chip.setAttribute('aria-pressed', String(value === goal)); chip.setAttribute('aria-label', `每天 ${value} 張`);
      goals.append(chip);
    }
    goals.append(el('span', '', '張'));
    todayBox.replaceChildren(ring, head, week, el('p', 'sumline', sum), goals);
    // The how-to is for the first visit: once something is decided, the card moves up.
    intro.hidden = read_ > 0;
  }
  function setGoal(value: number) {
    goal = value; keep(KEYS.goal, value);
    if (state !== 'card' && decidedToday().length < goal * stacks()) pick(); else if (state === 'done') showDone(false);
    renderToday();
  }

  /** The cards still waiting for this reviewer; once only those put back today are left, they come back. */
  function candidates() {
    const mine = host.mine();
    const waiting = host.items().filter(item => !done(item, mine[item.id]));
    let open = waiting.filter(item => !skipped.has(item.id));
    if (!open.length && waiting.length) { skipped.clear(); saveSkip(); open = waiting; }
    return open;
  }
  function pick() {
    const open = candidates();
    const facts = open.map(item => candidate(item, host.mine()[item.id], othersOn(item.id), host.allVotesOn(item.id), host.hasPre(item), host.quorum()));
    const next = nextCard(facts, bossSlot(decidedToday().length, goal));
    if (!next) { current = undefined; showEmpty(); return; }
    mount(open.find(item => item.id === next.id)!, next.boss);
  }
  /** After a decision or a card put back: the next card, or the day's stack is done. */
  function advance() {
    if (decidedToday().length >= goal * stacks()) { showDone(true); return; }
    pick();
  }

  function mount(item: Item, challenge: boolean) {
    current = item; boss = challenge; state = 'card'; resting = false;
    const card = host.buildCard(item);
    card.classList.add('deckcard');
    if (challenge) card.classList.add('boss');
    const others = othersOn(item.id), own = host.mine()[item.id];
    const tag = challenge ? '挑戰卡・還沒有人審過，你是第一位' : candidate(item, own, others, host.allVotesOn(item.id), false, host.quorum()).oneAway ? '差你一票就達門檻'
      : own?.d ? '內容改過，請再看一次' : '';
    if (tag) {
      const top = el('div', 'decktag');
      top.append(el('b', '', tag));
      if (challenge) top.append(el('span', '', '沒有預審可參考，慢慢看。'));
      card.prepend(top);
    }
    if (!still()) card.classList.add('enter');
    stage.replaceChildren(card);
    host.updateCard(item);
    swipe(card);
    shownAt = performance.now();
    renderBar();
    renderToday();
  }
  function renderBar() {
    const card = stage.querySelector('.deckcard');
    bar.hidden = state !== 'card';
    if (!card || state !== 'card') { bar.replaceChildren(); return; }
    if (card.classList.contains('open')) {
      bar.className = 'deckbar two';
      bar.replaceChildren(button('', '收起', () => { card.classList.remove('open'); renderBar(); }), button('yes', '下一張 →', next));
    } else {
      bar.className = 'deckbar';
      bar.replaceChildren(button('later', '← 稍後', later), button('note', '有意見', open), button('yes', '同意 →', agree));
    }
  }
  function open() {
    const card = stage.querySelector<HTMLElement>('.deckcard');
    if (!card || !current || !host.ready()) return;
    card.classList.add('open');
    clearTimeout(toastTimer); toast.hidden = true;
    renderBar();
    card.querySelector('.choices')?.scrollIntoView({ block: 'center', behavior: still() ? 'auto' : 'smooth' });
  }
  /** The open card is finished with: decided, it counts and the next comes; otherwise it is put back for later. */
  function next() {
    if (!current) return;
    if (done(current, host.mine()[current.id])) { logDay(); say('已記下你的意見'); fly(1, advance); }
    else later();
  }

  function agree() {
    const item = current, card = stage.querySelector<HTMLElement>('.deckcard');
    if (!item || !card) return;
    if (!host.ready()) { snap(card); return; }
    if (performance.now() - shownAt < (boss ? LOOK_BOSS : LOOK)) { snap(card); say(boss ? '挑戰卡沒有人看過，先讀完內容再決定' : '先看一下內容，再決定'); return; }
    const before = host.mine()[item.id], challenge = boss;
    host.agree(item);
    logDay();
    const team = host.teamVotesOn(item.id), quorum = host.quorum();
    const agreed = tally(item, team).同意.length;
    const message = reachedBy(item, team, quorum, host.me()) ? '這條因為你達門檻了！' : challenge ? '挑戰完成：你是這條的第一位審核者'
      : `已同意・團隊同意 ${agreed}／${quorum}`;
    if ('vibrate' in navigator) try { navigator.vibrate(10); } catch { /* not every phone */ }
    fly(1, advance);
    say(message, () => { host.restore(item, before); mount(item, challenge); });
  }
  function later() {
    const item = current, challenge = boss;
    if (!item) return;
    skipped.add(item.id); saveSkip();
    fly(-1, advance);
    say('先放著，今天晚點會再出現', () => { skipped.delete(item.id); saveSkip(); mount(item, challenge); });
  }

  function say(text: string, undo?: () => void) {
    clearTimeout(toastTimer);
    toast.replaceChildren(el('span', '', text));
    if (undo) toast.append(button('undo', '復原', () => { toast.hidden = true; undo(); }));
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, TOAST);
  }
  function fly(direction: 1 | -1, then: () => void) {
    const card = stage.querySelector<HTMLElement>('.deckcard');
    state = 'empty';
    if (!card || still()) { then(); return; }
    card.classList.remove('dragging');
    card.style.transition = 'transform .22s ease-in, opacity .22s ease-in';
    card.style.transform = `translateX(${direction * 120}%) rotate(${direction * 12}deg)`;
    card.style.opacity = '0';
    setTimeout(then, 200);
  }
  function snap(card: HTMLElement) {
    card.classList.remove('dragging');
    delete card.dataset.swipe;
    card.style.transition = still() ? '' : 'transform .2s ease-out';
    card.style.transform = '';
  }
  /** Sideways drags move the card; up and down still scroll the page. Buttons, links and boxes inside keep their own touch. */
  function swipe(card: HTMLElement) {
    let x0 = 0, y0 = 0, t0 = 0, dx = 0, pointer = -1, mode: '' | 'maybe' | 'x' = '';
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0 || card.classList.contains('open') || (event.target as Element).closest('button, a, textarea, input, summary, select')) return;
      x0 = event.clientX; y0 = event.clientY; t0 = performance.now(); dx = 0; pointer = event.pointerId; mode = 'maybe';
    });
    card.addEventListener('pointermove', event => {
      if (event.pointerId !== pointer || !mode) return;
      const mx = event.clientX - x0, my = event.clientY - y0;
      if (mode === 'maybe') {
        if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) { mode = ''; return; }
        if (Math.abs(mx) < 12) return;
        mode = 'x'; card.classList.add('dragging'); card.style.transition = '';
        try { card.setPointerCapture(pointer); } catch { /* the drag still works without */ }
      }
      dx = mx;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
      if (dx > 48) card.dataset.swipe = 'yes'; else if (dx < -48) card.dataset.swipe = 'no'; else delete card.dataset.swipe;
    });
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      const was = mode; mode = ''; pointer = -1;
      if (was !== 'x') return;
      const fast = Math.abs(dx) > 60 && Math.abs(dx) / Math.max(1, performance.now() - t0) > 0.6;
      if (event.type === 'pointerup' && (Math.abs(dx) > card.offsetWidth * 0.3 || fast)) { if (dx > 0) agree(); else later(); }
      else snap(card);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  function showDone(celebrate: boolean) {
    state = 'done'; current = undefined;
    const byId = new Map(host.items().map(item => [item.id, item]));
    const todays = decidedToday().map(id => byId.get(id)).filter((item): item is Item => !!item);
    const learned = learnedClasses(todays, host.atc());
    const reached = todays.filter(item => reachedBy(item, host.teamVotesOn(item.id), host.quorum(), host.me())).length;
    const firsts = todays.filter(item => firstOn(host.allVotesOn(item.id), host.me())).length;
    const team = teamWeek(host.items().map(item => host.teamVotesOn(item.id)), weekStart(new Date()));
    const doneBox = el('div', 'donebox');
    doneBox.append(el('h2', '', stacks() > 1 ? '加碼的一疊也完成了' : '今天的一疊完成了'));
    doneBox.append(el('p', 'lead', '今天又多讀到一點書：'));
    if (learned.length) { const chips = el('div', 'learned'); for (const name of learned) chips.append(el('span', '', name)); doneBox.append(chips); }
    else doneBox.append(el('p', 'sub', '今天看的是設定、提案或待決定的事，沒有新的藥品類別。'));
    doneBox.append(el('p', '', `你今天推進了 ${todays.length} 條${reached ? `，其中 ${reached} 條因為你達門檻` : ''}。`));
    if (firsts) doneBox.append(el('p', '', `今日挑戰：完成，${firsts > 1 ? `${firsts} 條` : '有一條'}你是第一位審核者。`));
    if (team) doneBox.append(el('p', 'sub', `團隊這週一起推進了 ${team} 條。`));
    const buttons = el('div', 'donebtns');
    const more = button('big yes', '再來一疊', () => { keep(KEYS.stacks, { date: today(), n: stacks() + 1 }); pick(); });
    const rest = button('big', '今天到此', () => { resting = true; buttons.replaceChildren(el('p', 'sub', '明天會有新的一疊。要改名字或看全部規則，請切換到清單模式。'), more); });
    buttons.append(more, rest);
    if (resting) rest.click();
    doneBox.append(buttons);
    stage.replaceChildren(doneBox);
    renderBar();
    renderToday();
    if (celebrate && !still()) confetti();
  }
  function showEmpty() {
    state = 'empty';
    stage.replaceChildren(el('p', 'empty', '目前沒有等你審的了。新條文與新提案加入時，會出現在這裡。'));
    renderBar();
    renderToday();
  }
  function confetti() {
    const layer = el('div', 'confetti');
    layer.setAttribute('aria-hidden', 'true');
    const colors = ['var(--accent)', 'var(--other)', 'var(--no)', 'var(--yellow)', 'var(--accent-soft)'];
    for (let n = 0; n < 32; n++) {
      const bit = el('i');
      bit.style.cssText = `--x:${Math.random() * 100}%;--d:${(Math.random() * 0.4).toFixed(2)}s;--dx:${(Math.random() * 120 - 60).toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;--c:${colors[n % colors.length]}`;
      layer.append(bit);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), 2600);
  }

  document.addEventListener('keydown', event => {
    if (box.hidden || state !== 'card' || event.altKey || event.ctrlKey || event.metaKey) return;
    if ((event.target as Element).closest('input, textarea, select')) return;
    if (stage.querySelector('.deckcard.open')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); agree(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); later(); }
  });

  return {
    /** Card mode was turned on, or the items arrived. */
    show() {
      if (state === 'card' && current && !closed(current)) { mount(current, boss); return; }
      if (decidedToday().length >= goal * stacks()) showDone(false); else pick();
    },
    /** The team's votes or the items changed: the card being read stays unless it is no longer waiting. */
    refresh() {
      if (state === 'card' && current) {
        const fresh = host.items().find(item => item.id === current!.id);
        const open = !!stage.querySelector('.deckcard.open');
        if (!fresh || closed(fresh) || (!open && done(fresh, host.mine()[fresh.id]))) { advance(); return; }
        current = fresh;
        host.updateCard(fresh);
        renderToday();
        return;
      }
      if (state === 'empty') pick(); else if (state === 'done') showDone(false);
    },
    /** A vote changed. */
    panel() { renderToday(); if (state === 'card') renderBar(); },
    status(text: string, warn: boolean) { status.textContent = text; status.classList.toggle('warn', warn); },
  };
}
