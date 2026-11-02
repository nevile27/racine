const CARD_W = 240;
const CARD_H = 118;

const LABELS = {
  given_name: "Prénom",
  family_name: "Nom",
  birth_date: "Naissance",
  death_date: "Décès",
  place: "Lieu",
  notes: "Note",
};

const state = {
  me: null,
  needsSetup: false,
  gate: "connexion",
  lastForm: null,
  people: [],
  relations: [],
  proposals: [],
  users: [],
  familyCode: "",
  selectedId: null,
  mode: null,
  addKind: "root",
  addAnchor: null,
  query: "",
  showPending: true,
  view: "around",
  centerId: null,
  photoId: null,
  zoom: 1,
  toast: "",
  toastTimer: null,
  busy: false,
  keepScroll: false,
  scrollLeft: 0,
  scrollTop: 0,
  scrollCardId: null,
  didCenter: false,
  suppressClick: false,
  glide: null,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function escBr(value) {
  return esc(value).replace(/\n/g, "<br>");
}

function isAdmin() {
  return Boolean(state.me && state.me.role === "admin");
}

function fullName(person) {
  return [person.given_name, person.family_name].filter(Boolean).join(" ") || "Sans nom";
}

function nameOf(id) {
  const person = personById(id);
  return person ? fullName(person) : "Personne retirée";
}

function initial(person) {
  const letter = (person.given_name || "?").trim().charAt(0);
  return letter.toLocaleUpperCase("fr-FR");
}

function personById(id) {
  return state.people.find((person) => person.id === id);
}

function proposalFor(personId) {
  return state.proposals.find((proposal) => proposal.person_id === personId);
}

function peopleAlpha() {
  return [...state.people].sort((a, b) => fullName(a).localeCompare(fullName(b), "fr"));
}

function formatFullDate(iso) {
  if (!iso) return "";
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function yearSpan(person) {
  const birth = (person.birth_date || "").slice(0, 4);
  const death = (person.death_date || "").slice(0, 4);
  if (birth && death) return `${birth} – ${death}`;
  if (birth) return birth;
  if (death) return `Décès ${death}`;
  return "";
}

function lifeLine(person) {
  const birth = formatFullDate(person.birth_date);
  const death = formatFullDate(person.death_date);
  if (birth && death) return `${birth} — ${death}`;
  if (birth) return birth;
  if (death) return `Décès le ${death}`;
  return "";
}

function spouseIds(id) {
  const ids = [];
  state.relations.forEach((relation) => {
    if (relation.kind !== "spouse") return;
    if (relation.person_a === id) ids.push(relation.person_b);
    else if (relation.person_b === id) ids.push(relation.person_a);
  });
  return ids;
}

function parentIds(id) {
  return state.relations
    .filter((relation) => relation.kind === "parent" && relation.person_b === id)
    .map((relation) => relation.person_a);
}

function num(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function api(url, options = {}) {
  const opts = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(url, opts);
  } catch {
    const error = new Error("Connexion au serveur impossible.");
    error.status = 0;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Une erreur est survenue.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function applyTree(data) {
  if (data && data.people) {
    state.people = data.people;
    state.relations = data.relations;
    state.proposals = data.proposals;
    state.familyCode = data.family_code || "";
    state.users = data.users || [];
    if (state.me && state.users.length) {
      const mine = state.users.find((user) => user.id === state.me.id);
      if (mine) state.me = { ...state.me, name: mine.name, role: mine.role };
    }
    if (state.selectedId && !personById(state.selectedId)) {
      state.selectedId = null;
      if (state.mode === "edit") state.mode = null;
    }
  }
  return data;
}

function queueToast(message) {
  state.toast = message;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = "";
    const toast = document.querySelector(".toast");
    if (toast) toast.classList.add("hidden");
  }, 4200);
}

function flash(message) {
  queueToast(message);
  const toast = document.querySelector(".toast");
  if (toast) {
    toast.textContent = message;
    toast.classList.remove("hidden");
  }
}

function handleError(error) {
  const message = error.message || "Une erreur est survenue.";
  if (error.status === 401 && state.me) {
    state.me = null;
    state.mode = null;
    state.selectedId = null;
    queueToast(message);
    render();
    return;
  }
  flash(message);
  const form = state.lastForm;
  const formError = form && form.isConnected
    ? form.querySelector(".form-error")
    : document.querySelector(".form-error");
  if (formError) {
    formError.textContent = message;
    formError.classList.remove("hidden");
  }
}

async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("busy");
  try {
    await fn();
  } catch (error) {
    handleError(error);
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

function saveScroll() {
  const board = document.getElementById("board");
  if (!board) return;
  state.scrollLeft = board.scrollLeft;
  state.scrollTop = board.scrollTop;
}

function logo() {
  return '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1e6b45"/><path d="M16 27V14" stroke="#f4efe6" stroke-width="1.6" stroke-linecap="round"/><path d="M16 20c-4-1-6-4-7-8 4 1 6 3 7 8zM16 17c3-2 6-3 9-3-1 5-4 7-9 8z" fill="#f6e4cf"/></svg>';
}

function validationHint() {
  if (isAdmin()) {
    return '<p class="hint">Vous êtes administrateur : cela apparaît tout de suite, en couleur pleine.</p>';
  }
  return '<p class="hint">Tout le monde le voit tout de suite, en teinte claire. Il prend la couleur du reste de l’arbre une fois validé.</p>';
}

function identityFields(values = {}) {
  return `
    <label class="field">Prénom
      <input name="given_name" required maxlength="80" value="${esc(values.given_name || "")}" autofocus>
    </label>
    <label class="field">Nom
      <input name="family_name" maxlength="80" value="${esc(values.family_name || "")}">
    </label>
    <div class="split">
      <label class="field">Naissance
        <input type="date" name="birth_date" value="${esc(values.birth_date || "")}">
      </label>
      <label class="field">Décès
        <input type="date" name="death_date" value="${esc(values.death_date || "")}">
      </label>
    </div>
    <p class="hint">Laissez le décès vide si la personne est en vie.</p>
    <label class="field">Lieu
      <input name="place" maxlength="120" value="${esc(values.place || "")}" placeholder="Ville, pays">
    </label>
    <label class="field">Note
      <textarea name="notes" maxlength="2000" placeholder="Un souvenir, un métier, un surnom…">${esc(values.notes || "")}</textarea>
    </label>
  `;
}

function optionPeople(selectedId, excludeId) {
  const options = peopleAlpha()
    .filter((person) => person.id !== excludeId)
    .map((person) => {
      const pending = person.status === "pending" ? " (en attente)" : "";
      const selected = person.id === selectedId ? "selected" : "";
      return `<option value="${person.id}" ${selected}>${esc(fullName(person) + pending)}</option>`;
    })
    .join("");
  return `<option value="">Choisir…</option>${options}`;
}

function passwordFields(confirm, autocomplete) {
  return `
    <label class="field">Mot de passe
      <input name="password" data-pass type="password" required minlength="4" maxlength="200" autocomplete="${autocomplete}">
    </label>
    ${confirm ? `<label class="field">Encore le mot de passe
      <input name="password_confirm" data-pass type="password" required minlength="4" maxlength="200" autocomplete="new-password">
    </label>` : ""}
    <label class="check"><input class="js-show-pass" type="checkbox"> Afficher le mot de passe</label>
  `;
}

function wrapGate(inner) {
  return `
    <main class="gate">
      <section class="gate-card">
        <div class="brand">${logo()}<div><div class="brand-name">Racine</div><div class="brand-sub">L'arbre de la famille</div></div></div>
        ${inner}
      </section>
      <div class="toast ${state.toast ? "" : "hidden"}" role="status">${esc(state.toast)}</div>
    </main>
  `;
}

function connexionGate() {
  return `
    <form id="form-code" class="stack">
      <label class="field code-field">Code familial
        <input class="code-entry" name="code" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD-2345" autofocus>
      </label>
      <p class="form-error hidden"></p>
      <button class="primary wide big" type="submit">Entrer</button>
    </form>
    <p class="or">ou</p>
    <form id="form-login" class="stack">
      <label class="field">Nom
        <input name="name" required maxlength="80" autocomplete="username">
      </label>
      <label class="field">Mot de passe
        <input name="password" data-pass type="password" required minlength="4" maxlength="200" autocomplete="current-password">
      </label>
      <label class="check"><input class="js-show-pass" type="checkbox"> Afficher</label>
      <p class="form-error hidden"></p>
      <button class="ghost wide" type="submit">Se connecter</button>
    </form>
  `;
}

function compteGate() {
  if (state.needsSetup) {
    return `
      <form id="form-setup" class="stack">
        <h2>Créer un arbre</h2>
        <p class="hint">Vous validerez les ajouts de la famille.</p>
        <label class="field">Votre nom
          <input name="name" required maxlength="80" autocomplete="username">
        </label>
        ${passwordFields(true, "new-password")}
        <p class="form-error hidden"></p>
        <button class="primary wide" type="submit">Créer l'arbre</button>
      </form>
      <div class="account-block">
        <h2>Créer un compte</h2>
        <p class="hint">Possible une fois l'arbre créé, avec le code familial.</p>
      </div>
    `;
  }
  return `
    <form id="form-join" class="stack">
      <h2>Créer un compte</h2>
      <p class="hint">Votre nom apparaîtra sur vos ajouts.</p>
      <label class="field">Code familial
        <input class="code-entry small" name="code" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="ABCD-2345">
      </label>
      <label class="field">Votre nom
        <input name="name" required maxlength="80" autocomplete="username">
      </label>
      ${passwordFields(true, "new-password")}
      <p class="form-error hidden"></p>
      <button class="primary wide" type="submit">Créer mon compte</button>
    </form>
    <div class="account-block">
      <h2>Créer un arbre</h2>
      <p class="hint">Un arbre existe déjà. Entrez avec le code familial, dans Connexion.</p>
    </div>
  `;
}

function gate() {
  const tab = state.gate === "compte" ? "compte" : "connexion";
  return wrapGate(`
    <div class="tabs">
      <button type="button" class="tab ${tab === "connexion" ? "active" : ""}" data-action="gate-tab" data-tab="connexion">Connexion</button>
      <button type="button" class="tab ${tab === "compte" ? "active" : ""}" data-action="gate-tab" data-tab="compte">Compte</button>
    </div>
    ${tab === "compte" ? compteGate() : connexionGate()}
  `);
}

function describeRole(personId, relation) {
  if (relation.kind === "spouse") {
    const other = relation.person_a === personId ? relation.person_b : relation.person_a;
    return `Conjoint de ${nameOf(other)}`;
  }
  if (relation.person_b === personId) return `Enfant de ${nameOf(relation.person_a)}`;
  return `Parent de ${nameOf(relation.person_b)}`;
}

function pendingLinkSummary(person) {
  const links = state.relations.filter((relation) => relation.batch_id && relation.batch_id === person.batch_id);
  if (!links.length) return "Nouvelle branche · en attente";
  return links.map((relation) => describeRole(person.id, relation)).join(" · ");
}

function proposalFoot(person, proposal) {
  if (proposal.kind === "delete") return "Suppression proposée";
  const payload = proposal.payload || {};
  const next = {
    given_name: payload.given_name ?? person.given_name,
    family_name: payload.family_name ?? person.family_name,
  };
  if (next.given_name !== person.given_name || next.family_name !== person.family_name) {
    return fullName(next);
  }
  const bits = [];
  ["birth_date", "death_date", "place"].forEach((key) => {
    if ((payload[key] ?? "") !== (person[key] ?? "")) {
      const value = key.endsWith("date")
        ? (formatFullDate(payload[key]) || "effacée")
        : (payload[key] || "effacé");
      bits.push(`${LABELS[key]} : ${value}`);
    }
  });
  if ((payload.notes ?? "") !== (person.notes ?? "")) bits.push("Note modifiée");
  return bits.join(" · ") || "Modification";
}

function cardFoot(person) {
  if (person.status === "pending") return pendingLinkSummary(person);
  if (!state.showPending) return person.place || "";
  const proposal = proposalFor(person.id);
  if (proposal) return proposalFoot(person, proposal);
  return person.place || "";
}

function describeRelation(relation) {
  if (relation.kind === "parent") {
    return `${nameOf(relation.person_a)} est parent de ${nameOf(relation.person_b)}`;
  }
  return `${nameOf(relation.person_a)} et ${nameOf(relation.person_b)} sont conjoints`;
}

function relationBelongsToPendingPerson(relation) {
  if (!relation.batch_id) return false;
  return state.people.some((person) => person.status === "pending" && person.batch_id === relation.batch_id);
}

function reviewItems() {
  const items = [];
  state.people.filter((person) => person.status === "pending").forEach((person) => {
    items.push({
      type: "person",
      id: person.id,
      personId: person.id,
      title: fullName(person),
      meta: `Proposé par ${person.created_by_name || "quelqu'un"}`,
      detail: pendingLinkSummary(person),
    });
  });
  state.relations.forEach((relation) => {
    if (relation.status === "pending" && !relationBelongsToPendingPerson(relation)) {
      items.push({
        type: "relation",
        id: relation.id,
        personId: relation.person_a,
        title: describeRelation(relation),
        meta: `Lien proposé par ${relation.created_by_name || "quelqu'un"}`,
        detail: "",
      });
    }
    if (relation.remove_proposed_by) {
      items.push({
        type: "removal",
        id: relation.id,
        personId: relation.person_a,
        title: `Retirer : ${describeRelation(relation)}`,
        meta: `Proposé par ${relation.remove_proposed_by_name || "quelqu'un"}`,
        detail: "",
      });
    }
  });
  state.proposals.forEach((proposal) => {
    const person = personById(proposal.person_id);
    if (!person) return;
    items.push({
      type: "proposal",
      id: proposal.id,
      personId: person.id,
      title: proposal.kind === "delete" ? `Supprimer ${fullName(person)}` : `Modifier ${fullName(person)}`,
      meta: `Proposé par ${proposal.created_by_name || "quelqu'un"}`,
      detail: proposal.kind === "update" ? proposalFoot(person, proposal) : "",
    });
  });
  return items;
}

function visibleGraph() {
  let people = state.people.slice();
  let relations = state.relations.slice();
  if (!state.showPending) {
    people = people.filter((person) => person.status === "approved");
    const ids = new Set(people.map((person) => person.id));
    relations = relations.filter((relation) => (
      relation.status === "approved"
      && !relation.remove_proposed_by
      && ids.has(relation.person_a)
      && ids.has(relation.person_b)
    ));
  } else {
    const ids = new Set(people.map((person) => person.id));
    relations = relations.filter((relation) => ids.has(relation.person_a) && ids.has(relation.person_b));
  }
  if (state.view !== "all" && people.length) {
    const ids = aroundIds(people, relations);
    people = people.filter((person) => ids.has(person.id));
    const set = new Set(people.map((person) => person.id));
    relations = relations.filter((relation) => set.has(relation.person_a) && set.has(relation.person_b));
  }
  return { people, relations };
}

function aroundIds(people, relations) {
  const known = new Set(people.map((person) => person.id));
  let center = state.centerId;
  if (!known.has(center)) center = people[0].id;
  const ids = new Set();
  const add = (id) => { if (known.has(id)) ids.add(id); };
  const spouses = (id) => relations
    .filter((relation) => relation.kind === "spouse" && (relation.person_a === id || relation.person_b === id))
    .map((relation) => (relation.person_a === id ? relation.person_b : relation.person_a));
  const kids = (id) => relations
    .filter((relation) => relation.kind === "parent" && relation.person_a === id)
    .map((relation) => relation.person_b);
  const parents = relations
    .filter((relation) => relation.kind === "parent" && relation.person_b === center)
    .map((relation) => relation.person_a);
  add(center);
  spouses(center).forEach(add);
  parents.forEach((parentId) => {
    add(parentId);
    spouses(parentId).forEach(add);
    kids(parentId).forEach((siblingId) => {
      add(siblingId);
      spouses(siblingId).forEach(add);
    });
  });
  kids(center).forEach((childId) => {
    add(childId);
    spouses(childId).forEach(add);
    kids(childId).forEach(add);
  });
  return ids;
}

function layoutTree(people, relations) {
  const spouseGap = 18;
  const sibGap = 36;
  const rowGap = 78;
  const pad = 48;
  const ids = people.map((person) => person.id);
  const idSet = new Set(ids);
  const parents = {};
  const children = {};
  const spouses = {};
  ids.forEach((id) => {
    parents[id] = [];
    children[id] = [];
    spouses[id] = [];
  });
  relations.forEach((relation) => {
    if (!idSet.has(relation.person_a) || !idSet.has(relation.person_b)) return;
    if (relation.kind === "parent") {
      parents[relation.person_b].push(relation.person_a);
      children[relation.person_a].push(relation.person_b);
    } else {
      spouses[relation.person_a].push(relation.person_b);
      spouses[relation.person_b].push(relation.person_a);
    }
  });
  const birth = {};
  people.forEach((person) => { birth[person.id] = person.birth_date || "9999-99-99"; });
  const byBirth = (a, b) => birth[a].localeCompare(birth[b]) || a - b;

  const brought = new Set(ids.filter((id) => (
    !parents[id].length && spouses[id].some((spouseId) => parents[spouseId].length)
  )));
  const rootIds = ids.filter((id) => !parents[id].length && !brought.has(id)).sort(byBirth);
  const seenRoot = new Set();
  const anchors = [];
  rootIds.forEach((id) => {
    if (seenRoot.has(id)) return;
    const stack = [id];
    const group = [];
    seenRoot.add(id);
    while (stack.length) {
      const current = stack.pop();
      group.push(current);
      spouses[current].forEach((spouseId) => {
        if (!parents[spouseId].length && !seenRoot.has(spouseId)) {
          seenRoot.add(spouseId);
          stack.push(spouseId);
        }
      });
    }
    group.sort(byBirth);
    anchors.push(group[0]);
  });
  const anchorSet = new Set(anchors);

  function hostOf(id) {
    const list = parents[id] || [];
    if (!list.length) return null;
    const blood = list.filter((parentId) => anchorSet.has(parentId) || parents[parentId].length);
    if (blood.length) return blood.slice().sort((a, b) => a - b)[0];
    for (const parentId of list) {
      const host = spouses[parentId].find((spouseId) => anchorSet.has(spouseId) || parents[spouseId].length);
      if (host) return host;
    }
    return list.slice().sort((a, b) => a - b)[0];
  }

  function partnersOf(id) {
    return spouses[id].filter((spouseId) => !parents[spouseId].length).sort(byBirth);
  }

  const seen = new Set();
  function measure(id) {
    if (seen.has(id)) return { id, partners: [], childMeasures: [], w: 0, h: 0, coupleW: 0, skip: true };
    seen.add(id);
    const partners = partnersOf(id);
    const kids = (children[id] || []).filter((childId) => hostOf(childId) === id).sort(byBirth);
    const grouped = new Map();
    kids.forEach((childId) => {
      const other = (parents[childId] || []).find((parentId) => parentId !== id) || 0;
      if (!grouped.has(other)) grouped.set(other, []);
      grouped.get(other).push(childId);
    });
    const order = [];
    partners.forEach((partnerId) => { if (grouped.has(partnerId)) order.push(partnerId); });
    if (grouped.has(0)) order.push(0);
    grouped.forEach((_, key) => { if (!order.includes(key)) order.push(key); });
    const childMeasures = [];
    order.forEach((key) => grouped.get(key).forEach((childId) => childMeasures.push(measure(childId))));
    const coupleW = (1 + partners.length) * CARD_W + partners.length * spouseGap;
    const kidsW = childMeasures.reduce((sum, node) => sum + node.w, 0)
      + sibGap * Math.max(0, childMeasures.length - 1);
    const w = Math.max(coupleW, kidsW, CARD_W);
    const kidsH = childMeasures.reduce((max, node) => Math.max(max, node.h), 0);
    const h = CARD_H + (childMeasures.length ? rowGap + kidsH : 0);
    return { id, partners, childMeasures, w, h, coupleW, skip: false };
  }

  const pos = {};
  const rails = [];
  function place(node, x, y) {
    if (!node || node.skip) return;
    const left = x + (node.w - node.coupleW) / 2;
    pos[node.id] = { x: left, y };
    node.partners.forEach((partnerId, index) => {
      pos[partnerId] = { x: left + (index + 1) * (CARD_W + spouseGap), y };
    });
    if (!node.childMeasures.length) return;
    const kidsW = node.childMeasures.reduce((sum, child) => sum + child.w, 0)
      + sibGap * Math.max(0, node.childMeasures.length - 1);
    let cursor = x + (node.w - kidsW) / 2;
    const childY = y + CARD_H + rowGap;
    const drops = [];
    node.childMeasures.forEach((child) => {
      place(child, cursor, childY);
      if (pos[child.id]) drops.push({ x: pos[child.id].x + CARD_W / 2, id: child.id });
      cursor += child.w + sibGap;
    });
    if (!drops.length) return;
    const originX = node.partners.length
      ? (pos[node.id].x + CARD_W / 2 + pos[node.partners[0]].x + CARD_W / 2) / 2
      : pos[node.id].x + CARD_W / 2;
    rails.push({
      originX,
      originY: y + CARD_H,
      railY: y + CARD_H + 26,
      childY,
      hostId: node.id,
      drops,
    });
  }

  let cursor = pad;
  let maxH = 0;
  anchors.forEach((id, index) => {
    const node = measure(id);
    if (index) cursor += 72;
    place(node, cursor, pad);
    cursor += node.w;
    maxH = Math.max(maxH, node.h);
  });
  ids.forEach((id) => {
    if (pos[id]) return;
    const node = measure(id);
    cursor += 72;
    place(node, cursor, pad);
    cursor += node.w;
    maxH = Math.max(maxH, node.h);
  });
  if (!Object.keys(pos).length) return { pos, rails, width: 0, height: 0 };
  return { pos, rails, width: cursor + pad, height: maxH + pad };
}

function relationStyle(relation) {
  if (relation.remove_proposed_by) return "removal";
  const left = personById(relation.person_a);
  const right = personById(relation.person_b);
  if (relation.status === "pending" || (left && left.status === "pending") || (right && right.status === "pending")) {
    return "pending";
  }
  return "ok";
}

function worstStyle(styles) {
  if (styles.includes("removal")) return "removal";
  if (styles.includes("pending")) return "pending";
  return "ok";
}

function edgePath(x1, y1, x2, y2) {
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

function linksSvg(people, relations, layout) {
  const { pos, width, height } = layout;
  const strokes = { ok: "#3d7a56", pending: "#c56a32", removal: "#9f3d3d" };
  const dashes = { ok: "", pending: "7 6", removal: "2 6" };
  const paths = [];

  relations.filter((relation) => relation.kind === "spouse" && pos[relation.person_a] && pos[relation.person_b]).forEach((relation) => {
    const leftId = pos[relation.person_a].x <= pos[relation.person_b].x ? relation.person_a : relation.person_b;
    const rightId = leftId === relation.person_a ? relation.person_b : relation.person_a;
    const x1 = pos[leftId].x + CARD_W;
    const x2 = pos[rightId].x;
    const y = pos[leftId].y + CARD_H / 2;
    const style = relationStyle(relation);
    let d;
    let dot;
    if (x2 - x1 < CARD_W) {
      d = `M ${x1} ${y} H ${x2}`;
      dot = [(x1 + x2) / 2, y];
    } else {
      const midY = y - 30;
      d = `M ${x1} ${y} C ${x1 + 36} ${midY}, ${x2 - 36} ${midY}, ${x2} ${y}`;
      dot = [(x1 + x2) / 2, midY];
    }
    paths.push({ d, style, dot, title: describeRelation(relation) });
  });

  (layout.rails || []).forEach((rail) => {
    const styled = rail.drops.map((drop) => {
      const link = relations.find((relation) => (
        relation.kind === "parent" && relation.person_a === rail.hostId && relation.person_b === drop.id
      ));
      return { ...drop, style: link ? relationStyle(link) : "ok" };
    });
    const bar = worstStyle(styled.map((drop) => drop.style));
    const xs = styled.map((drop) => drop.x);
    const minX = Math.min(rail.originX, ...xs);
    const maxX = Math.max(rail.originX, ...xs);
    paths.push({
      d: `M ${rail.originX} ${rail.originY} V ${rail.railY} M ${minX} ${rail.railY} H ${maxX}`,
      style: bar,
      title: "Enfants",
    });
    styled.forEach((drop) => {
      paths.push({
        d: `M ${drop.x} ${rail.railY} V ${rail.childY}`,
        style: drop.style,
        title: `Enfant : ${nameOf(drop.id)}`,
      });
    });
  });

  const markup = paths.map((path) => {
    const dash = dashes[path.style] ? ` stroke-dasharray="${dashes[path.style]}"` : "";
    const dot = path.dot
      ? `<circle cx="${path.dot[0]}" cy="${path.dot[1]}" r="4" fill="#fffdf8" stroke="${strokes[path.style]}" stroke-width="2"><title>${esc(path.title)}</title></circle>`
      : "";
    return `<path d="${path.d}" fill="none" stroke="${strokes[path.style]}" stroke-width="2" stroke-linecap="round"${dash}><title>${esc(path.title)}</title></path>${dot}`;
  }).join("");
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${markup}</svg>`;
}

function cardHtml(person, position) {
  if (!position) return "";
  const proposal = state.showPending ? proposalFor(person.id) : null;
  const classes = ["card"];
  if (person.status === "pending") classes.push("is-pending");
  else if (proposal && proposal.kind === "delete") classes.push("has-delete");
  else if (proposal && proposal.kind === "update") classes.push("has-edit");
  if (state.selectedId === person.id) classes.push("selected");
  const query = state.query.trim().toLocaleLowerCase("fr-FR");
  const blob = `${fullName(person)} ${person.place || ""}`.toLocaleLowerCase("fr-FR");
  if (query && blob.includes(query)) classes.push("matched");
  if (query && !blob.includes(query)) classes.push("dimmed");
  const tip = person.status === "pending" || proposal
    ? `Proposé par ${(proposal ? proposal.created_by_name : person.created_by_name) || "un membre"}`
    : fullName(person);
  return `
    <article class="${classes.join(" ")}" data-id="${person.id}" data-search="${esc(blob)}" tabindex="0" role="button" title="${esc(tip)}" style="left:${position.x}px;top:${position.y}px;width:${CARD_W}px;height:${CARD_H}px">
      <div class="card-main">
        ${person.photo_id
          ? `<img class="avatar photo" src="/api/photos/${person.photo_id}" alt="">`
          : `<span class="avatar" aria-hidden="true">${esc(initial(person))}</span>`}
        <div class="card-text">
          <div class="name">${esc(fullName(person))}</div>
          <div class="years">${esc(yearSpan(person))}</div>
        </div>
      </div>
      <div class="card-foot">${esc(cardFoot(person))}</div>
    </article>
  `;
}

function emptyState() {
  const text = isAdmin()
    ? "Ajoutez la première personne. Vos ajouts apparaissent tout de suite. Ceux de la famille restent en teinte claire jusqu'à votre validation."
    : "L'arbre est encore vide. Vous pouvez proposer la première personne : elle restera en teinte claire jusqu'à la validation.";
  return `<div class="empty">${logo()}<h2>L'arbre commence ici</h2><p>${esc(text)}</p><button type="button" class="primary" data-action="add-open">Ajouter un proche</button></div>`;
}

function boardHtml() {
  const graph = visibleGraph();
  if (!state.people.length) return emptyState();
  if (!graph.people.length) {
    return '<div class="empty"><h2>Propositions masquées</h2><p>Cochez « Voir les propositions » pour afficher les fiches en attente.</p></div>';
  }
  const layout = layoutTree(graph.people, graph.relations);
  const zoom = state.zoom;
  const around = state.view !== "all";
  return `
    <div class="board-tools">
      <div class="view-switch">
        <button type="button" class="${around ? "active" : ""}" data-action="set-view" data-view="around">Autour</button>
        <button type="button" class="${around ? "" : "active"}" data-action="set-view" data-view="all">Toute la famille</button>
      </div>
      <p class="hint">${around ? "Glissez pour déplacer l'arbre. Cliquez une personne pour aller dans sa famille." : "Glissez pour déplacer l'arbre."}</p>
    </div>
    <div class="zoombar">
      <button type="button" data-action="zoom-out" aria-label="Réduire">−</button>
      <span class="zoom-label">${Math.round(zoom * 100)} %</span>
      <button type="button" data-action="zoom-in" aria-label="Agrandir">+</button>
      <button type="button" class="ghost tiny" data-action="zoom-fit">Ajuster</button>
    </div>
    <div class="board" id="board">
      <div class="board-scale" style="width:${layout.width * zoom}px;height:${layout.height * zoom}px">
        <div class="board-inner" data-w="${layout.width}" data-h="${layout.height}" style="width:${layout.width}px;height:${layout.height}px;transform:scale(${zoom})">
          ${linksSvg(graph.people, graph.relations, layout)}
          ${graph.people.map((person) => cardHtml(person, layout.pos[person.id])).join("")}
        </div>
      </div>
    </div>
  `;
}

function headerButtons() {
  const count = reviewItems().length;
  const review = isAdmin()
    ? `<button type="button" class="${count ? "warn" : "ghost"}" data-action="open-review">À valider${count ? `<span class="badge">${count}</span>` : ""}</button>`
    : "";
  const members = isAdmin() ? '<button type="button" class="ghost" data-action="open-members">Membres</button>' : "";
  return `
    <button type="button" class="primary" data-action="add-open">Ajouter un proche</button>
    ${review}
    <button type="button" class="ghost" data-action="open-invite">Inviter</button>
    ${members}
    <button type="button" class="ghost" data-action="open-account">${esc(state.me.name)}</button>
    <button type="button" class="ghost" data-action="logout">Quitter</button>
  `;
}

function diffBlock(person, payload) {
  const rows = Object.keys(LABELS).filter((key) => (payload[key] ?? "") !== (person[key] ?? "")).map((key) => {
    const before = key.endsWith("date") ? (formatFullDate(person[key]) || "—") : (person[key] || "—");
    const after = key.endsWith("date") ? (formatFullDate(payload[key]) || "—") : (payload[key] || "—");
    return `<div class="diff-row"><div class="diff-label">${LABELS[key]}</div><div class="before">${esc(before)}</div><div class="after">${esc(after)}</div></div>`;
  });
  return rows.join("") || "<p>Aucun changement visible.</p>";
}

function relationsOf(person) {
  return state.relations
    .filter((relation) => relation.person_a === person.id || relation.person_b === person.id)
    .map((relation) => {
      const otherId = relation.person_a === person.id ? relation.person_b : relation.person_a;
      let word = "Lien";
      if (relation.kind === "spouse") word = "Conjoint";
      else if (relation.person_a === person.id) word = "Enfant";
      else word = "Parent";
      let note = "";
      if (relation.status === "pending") note = "en attente";
      if (relation.remove_proposed_by) note = "retrait proposé";
      return { relation, otherId, word, note };
    })
    .sort((a, b) => {
      const order = { Parent: 0, Conjoint: 1, Enfant: 2, Lien: 3 };
      return (order[a.word] - order[b.word]) || a.otherId - b.otherId;
    });
}

function kinList(person) {
  const items = relationsOf(person);
  if (!items.length) return '<p class="hint">Aucun proche relié pour l\'instant.</p>';
  return `<div class="kin-list">${items.map((item) => `
    <button type="button" class="kin" data-action="focus-person" data-id="${item.otherId}">
      <span class="kin-role">${item.word}</span>
      <span class="kin-name">${esc(nameOf(item.otherId))}</span>
      ${item.note ? `<span class="kin-note">${esc(item.note)}</span>` : ""}
    </button>
  `).join("")}</div>`;
}

function linkRows(person) {
  const links = state.relations.filter((relation) => relation.person_a === person.id || relation.person_b === person.id);
  if (!links.length) return "<p class=\"hint\">Aucun lien pour l'instant.</p>";
  return links.filter((relation) => relation.status === "pending" || relation.remove_proposed_by).map((relation) => {
    const otherId = relation.person_a === person.id ? relation.person_b : relation.person_a;
    let word = "Lien";
    if (relation.kind === "spouse") word = "Conjoint";
    else if (relation.person_a === person.id) word = "Enfant";
    else word = "Parent";
    let note = "";
    if (relation.status === "pending") note = " · en attente";
    if (relation.remove_proposed_by) note = " · retrait proposé";
    let actions = "";
    if (relation.status === "pending") {
      if (isAdmin() || relation.created_by === state.me.id) {
        actions = `<button type="button" class="ghost tiny" data-action="remove-link" data-id="${relation.id}">Retirer</button>`;
      }
    } else if (relation.remove_proposed_by) {
      if (isAdmin()) {
        actions = `
          <button type="button" class="primary tiny" data-action="review" data-review-action="approve" data-kind="removal" data-id="${relation.id}">Valider le retrait</button>
          <button type="button" class="ghost tiny" data-action="review" data-review-action="reject" data-kind="removal" data-id="${relation.id}">Garder le lien</button>
        `;
      } else if (relation.remove_proposed_by === state.me.id) {
        actions = `<button type="button" class="ghost tiny" data-action="cancel-removal" data-id="${relation.id}">Annuler le retrait</button>`;
      }
    } else if (isAdmin()) {
      actions = `<button type="button" class="ghost tiny" data-action="remove-link" data-id="${relation.id}">Retirer</button>`;
    } else {
      actions = `<button type="button" class="ghost tiny" data-action="remove-link" data-id="${relation.id}">Proposer le retrait</button>`;
    }
    return `
      <div class="link-row">
        <div><strong>${word}${note}</strong> · <button type="button" class="person-link" data-action="focus-person" data-id="${otherId}">${esc(nameOf(otherId))}</button></div>
        <div class="row-actions">${actions}</div>
      </div>
    `;
  }).join("");
}

function photosHTML(person) {
  const photos = person.photos || [];
  const shown = photos.includes(state.photoId) ? state.photoId : person.photo_id;
  const hero = shown
    ? `<button type="button" class="hero-photo" data-action="open-photo" data-id="${shown}" aria-label="Photo de ${esc(fullName(person))}"><img src="/api/photos/${shown}" alt=""></button>`
    : `<button type="button" class="hero-photo is-empty" data-action="pick-photo">Ajouter une photo</button>`;
  const thumbs = photos.length > 1 ? `<div class="photo-strip">${photos.map((id) => `
    <button type="button" class="photo-thumb ${id === shown ? "is-shown" : ""}" data-action="open-photo" data-id="${id}" aria-label="Voir cette photo">
      <img src="/api/photos/${id}" alt="">
    </button>
  `).join("")}</div>` : "";
  const cover = shown && shown !== person.photo_id
    ? `<button type="button" class="ghost tiny" data-action="cover-photo" data-id="${shown}">Montrer sur la tuile</button>`
    : "";
  const remove = shown
    ? `<button type="button" class="ghost tiny" data-action="delete-photo" data-id="${shown}">Retirer cette photo</button>`
    : "";
  return `
    <section class="photos">
      ${hero}
      <div class="photo-tools">
        ${thumbs}
        <div class="row-actions">
          ${shown ? '<button type="button" class="ghost tiny" data-action="pick-photo">Ajouter</button>' : ""}
          ${cover}
          ${remove}
        </div>
      </div>
      <input class="js-photo" type="file" accept="image/*" hidden>
    </section>
  `;
}

function personView(person) {
  const proposal = proposalFor(person.id);
  const parts = [photosHTML(person), '<div class="fiche">'];
  const life = [lifeLine(person), person.place].filter(Boolean).join(" · ");
  if (life) parts.push(`<p class="life">${esc(life)}</p>`);
  if (person.notes) parts.push(`<p class="notes">${escBr(person.notes)}</p>`);

  if (person.status === "pending") {
    parts.push(`
      <div class="proposal-box">
        <strong>En attente de validation</strong>
        <p>${esc(pendingLinkSummary(person))}</p>
        <p class="hint">Proposé par ${esc(person.created_by_name || "un membre")}. La fiche est visible, dans une teinte plus claire, jusqu'à la validation.</p>
        <div class="row-actions">
          ${isAdmin() ? `<button type="button" class="primary tiny" data-action="review" data-review-action="approve" data-kind="person" data-id="${person.id}">Valider</button>
            <button type="button" class="danger tiny" data-action="review" data-review-action="reject" data-kind="person" data-id="${person.id}">Refuser</button>` : ""}
          ${(isAdmin() || person.created_by === state.me.id) ? `<button type="button" class="ghost tiny" data-action="edit-open">Corriger</button>
            <button type="button" class="ghost tiny" data-action="delete-person" data-id="${person.id}">Retirer la proposition</button>` : ""}
        </div>
      </div>
    `);
  } else if (proposal) {
    const boxClass = proposal.kind === "delete" ? "proposal-box is-delete" : "proposal-box";
    const title = proposal.kind === "delete" ? "Suppression proposée" : "Modification proposée";
    const body = proposal.kind === "delete"
      ? "<p>La fiche reste visible ainsi jusqu'à la décision. Si elle est validée, elle quitte l'arbre.</p>"
      : diffBlock(person, proposal.payload || {});
    const mine = proposal.created_by === state.me.id;
    parts.push(`
      <div class="${boxClass}">
        <strong>${title}</strong>
        <p class="hint">Proposé par ${esc(proposal.created_by_name || "un membre")}.</p>
        ${body}
        <div class="row-actions">
          ${isAdmin() ? `<button type="button" class="primary tiny" data-action="review" data-review-action="approve" data-kind="proposal" data-id="${proposal.id}">Valider</button>
            <button type="button" class="danger tiny" data-action="review" data-review-action="reject" data-kind="proposal" data-id="${proposal.id}">Refuser</button>` : ""}
          ${(mine || isAdmin()) && proposal.kind === "update" ? '<button type="button" class="ghost tiny" data-action="edit-open">Modifier la proposition</button>' : ""}
          ${(mine || isAdmin()) ? `<button type="button" class="ghost tiny" data-action="withdraw-proposal" data-id="${proposal.id}">Retirer la proposition</button>` : ""}
        </div>
      </div>
    `);
  }

  if (person.status === "approved" && !(proposal && proposal.kind === "delete")) {
    const editButton = proposal && proposal.kind === "update"
      ? ""
      : `<button type="button" class="primary" data-action="edit-open">${isAdmin() ? "Corriger la fiche" : "Proposer une correction"}</button>`;
    parts.push(`<div class="fiche-actions">${editButton}</div>`);
    parts.push(`<h3>Famille</h3>${kinList(person)}`);
    parts.push(`
      <h3>Ajouter</h3>
      <div class="add-grid">
        <button type="button" class="ghost" data-action="add-child">Un enfant</button>
        <button type="button" class="ghost" data-action="add-parent">Un parent</button>
        <button type="button" class="ghost" data-action="add-spouse">Un conjoint</button>
        ${parentIds(person.id).length ? '<button type="button" class="ghost" data-action="add-sibling">Un frère ou une sœur</button>' : ""}
      </div>
    `);
  } else if (person.status === "pending" && (isAdmin() || person.created_by === state.me.id)) {
    parts.push(`
      <div class="row-actions">
        <button type="button" class="ghost" data-action="add-child">Ajouter un enfant</button>
        <button type="button" class="ghost" data-action="add-parent">Ajouter un parent</button>
        <button type="button" class="ghost" data-action="add-spouse">Ajouter un conjoint</button>
      </div>
    `);
  }

  const urgent = relationsOf(person).filter((item) => item.relation.status === "pending" || item.relation.remove_proposed_by);
  if (urgent.length) parts.push(`<h3>À décider</h3>${linkRows(person)}`);

  if (state.people.length > 1 && person.status === "approved" && !(proposal && proposal.kind === "delete")) {
    parts.push(`
      <details class="fold">
      <summary>Relier quelqu'un déjà dans l'arbre</summary>
      <form data-form="link" class="stack">
        <label class="field">Cette personne
          <select name="role" aria-label="Type de lien">
            <option value="parent">est un parent</option>
            <option value="child">est un enfant</option>
            <option value="spouse">est un conjoint</option>
          </select>
        </label>
        <label class="field">De
          <select name="other_id" aria-label="Personne">${optionPeople(null, person.id)}</select>
        </label>
        <input type="hidden" name="person_id" value="${person.id}">
        ${validationHint()}
        <button class="primary" type="submit">${isAdmin() ? "Ajouter le lien" : "Proposer le lien"}</button>
      </form>
      </details>
    `);
  }

  if (person.status === "approved" && !(proposal && proposal.kind === "delete")) {
    const label = isAdmin() ? "Supprimer de l'arbre" : "Proposer la suppression";
    parts.push(`<button type="button" class="text-danger" data-action="delete-person" data-id="${person.id}">${label}</button>`);
  }
  parts.push("</div>");
  return parts.join("");
}

function alsoParentsHTML(anchorId) {
  const anchor = personById(Number(anchorId));
  if (!anchor) return "";
  const spouses = spouseIds(anchor.id);
  if (!spouses.length) return "";
  const boxes = spouses.map((id) => {
    const spouse = personById(id);
    const checked = spouses.length === 1 ? "checked" : "";
    return `<label class="check"><input type="checkbox" name="also" value="${id}" ${checked}> ${esc(fullName(spouse))}</label>`;
  }).join("");
  return `<fieldset class="also"><legend>Autre parent</legend>${boxes}</fieldset>`;
}

function addForm() {
  const hasPeople = state.people.length > 0;
  const kind = hasPeople ? (state.addKind || "root") : "root";
  const anchor = state.addAnchor || state.selectedId || "";
  const kindField = hasPeople ? `
    <label class="field">Ajouter
      <select id="kind" name="kind" aria-label="Type de lien">
        <option value="child_of" ${kind === "child_of" ? "selected" : ""}>un enfant de</option>
        <option value="parent_of" ${kind === "parent_of" ? "selected" : ""}>un parent de</option>
        <option value="spouse_of" ${kind === "spouse_of" ? "selected" : ""}>le conjoint de</option>
        <option value="sibling_of" ${kind === "sibling_of" ? "selected" : ""}>un frère ou une sœur de</option>
        <option value="root" ${kind === "root" ? "selected" : ""}>une nouvelle branche</option>
      </select>
    </label>
    <div id="anchor-field" class="field">
      <span>Personne</span>
      <select id="anchor" name="anchor_id" aria-label="Personne">${optionPeople(num(anchor), null)}</select>
    </div>
    <p id="hint-sibling" class="hint hidden">La nouvelle personne aura les mêmes parents.</p>
    <p id="hint-root" class="hint hidden">Elle apparaîtra à part, sans lien pour l'instant. Vous pourrez la relier plus tard.</p>
    <div id="also-parents"></div>
  ` : '<input type="hidden" id="kind" name="kind" value="root"><p class="hint">La première personne ouvre l\'arbre.</p>';
  return `
    <form id="form-add" class="stack" autocomplete="off">
      ${kindField}
      ${identityFields({})}
      ${validationHint()}
      <div class="row-actions">
        <button class="primary" type="submit">${isAdmin() ? "Ajouter à l'arbre" : "Proposer l'ajout"}</button>
        <button type="button" class="ghost" data-action="cancel-form">Annuler</button>
      </div>
    </form>
  `;
}

function editSource(person) {
  const proposal = proposalFor(person.id);
  if (proposal && proposal.kind === "update") return { ...person, ...proposal.payload };
  return person;
}

function editForm() {
  const person = personById(state.selectedId);
  if (!person) return "<p>Cette fiche n'est plus là.</p>";
  const proposal = proposalFor(person.id);
  if (proposal && proposal.kind === "delete") {
    return "<p>Une suppression est déjà proposée. Validez-la, refusez-la, ou retirez-la avant de modifier la fiche.</p>";
  }
  let label = "Proposer la modification";
  if (person.status === "pending" || (isAdmin() && !proposal)) label = "Enregistrer";
  else if (proposal) label = "Mettre à jour la proposition";
  return `
    <form id="form-edit" class="stack" autocomplete="off">
      <p class="hint">Le prénom, le nom, les dates, le lieu et la note peuvent être repris.</p>
      ${identityFields(editSource(person))}
      ${person.status === "pending" ? "" : validationHint()}
      <div class="row-actions">
        <button class="primary" type="submit">${label}</button>
        <button type="button" class="ghost" data-action="cancel-form">Annuler</button>
      </div>
    </form>
  `;
}

function reviewView() {
  const items = reviewItems();
  if (!items.length) {
    return "<p>Aucune proposition en attente. L'arbre est à jour.</p>";
  }
  const cards = items.map((item) => `
    <article class="review-item">
      <strong>${esc(item.title)}</strong>
      <p class="hint">${esc(item.meta)}</p>
      ${item.detail ? `<p>${esc(item.detail)}</p>` : ""}
      <div class="row-actions">
        <button type="button" class="ghost tiny" data-action="focus-person" data-id="${item.personId}">Voir</button>
        <button type="button" class="primary tiny" data-action="review" data-review-action="approve" data-kind="${item.type}" data-id="${item.id}">Valider</button>
        <button type="button" class="danger tiny" data-action="review" data-review-action="reject" data-kind="${item.type}" data-id="${item.id}">Refuser</button>
      </div>
    </article>
  `).join("");
  return `
    <p class="hint">Ces propositions sont déjà visibles dans l'arbre, en teinte claire. Après validation, elles s'affichent comme le reste.</p>
    ${cards}
  `;
}

function inviteView() {
  const renew = isAdmin()
    ? '<button type="button" class="ghost" data-action="regen-code">Nouveau code</button>'
    : "";
  return `
    <p>Chacun ouvre Racine et entre ce code.</p>
    <p class="hint">Pour un compte à son nom, l'onglet Compte.</p>
    <div class="code">${esc(state.familyCode || "")}</div>
    <div class="row-actions">
      <button type="button" class="primary" data-action="copy-code">Copier</button>
      ${renew}
    </div>
    <p class="hint">Sur le même réseau, les autres utilisent l'adresse affichée au lancement de Racine.</p>
  `;
}

function membersView() {
  const rows = state.users.map((user) => {
    if (user.shared) {
      return `
        <div class="user-row">
          <strong>${esc(user.name)}</strong>
          <p class="hint">Accès avec le code familial</p>
        </div>
      `;
    }
    const role = user.role === "admin" ? "Administrateur" : "Membre";
    let roleButton = "";
    if (user.id !== state.me.id && user.role === "member") {
      roleButton = `<button type="button" class="ghost tiny" data-action="promote" data-id="${user.id}">Rendre administrateur</button>`;
    } else if (user.id !== state.me.id && user.role === "admin") {
      roleButton = `<button type="button" class="ghost tiny" data-action="demote" data-id="${user.id}">Retirer l'administration</button>`;
    }
    return `
      <div class="user-row">
        <strong>${esc(user.name)}</strong>
        <p class="hint">${role}</p>
        <div class="row-actions">${roleButton}</div>
        <form data-form="reset" class="stack">
          <input type="hidden" name="user_id" value="${user.id}">
          <label class="field">Nouveau mot de passe
            <input name="password" data-pass type="password" required minlength="4" maxlength="200" autocomplete="new-password">
          </label>
          <button class="ghost tiny" type="submit">Changer le mot de passe</button>
        </form>
      </div>
    `;
  }).join("");
  return `
    <p class="hint">Vous pouvez aussi laisser chacun rejoindre l'arbre avec le code, depuis « Inviter ».</p>
    ${rows}
    <form id="form-member" class="stack">
      <h3>Ajouter un membre</h3>
      <label class="field">Nom
        <input name="name" required maxlength="80" autocomplete="off">
      </label>
      <label class="field">Mot de passe à lui donner
        <input name="password" data-pass type="password" required minlength="4" maxlength="200" autocomplete="new-password">
      </label>
      <label class="check"><input class="js-show-pass" type="checkbox"> Afficher le mot de passe</label>
      <button class="primary" type="submit">Créer le membre</button>
    </form>
  `;
}

function accountView() {
  if (state.me.shared) {
    return "<p>Vous êtes entré avec le code familial.</p>";
  }
  return `
    <p>Connecté en tant que <strong>${esc(state.me.name)}</strong>${isAdmin() ? ", administrateur." : "."}</p>
    <form id="form-account" class="stack">
      <h3>Changer mon mot de passe</h3>
      <label class="field">Mot de passe actuel
        <input name="current_password" data-pass type="password" required autocomplete="current-password">
      </label>
      <label class="field">Nouveau mot de passe
        <input name="new_password" data-pass type="password" required minlength="4" maxlength="200" autocomplete="new-password">
      </label>
      <label class="field">Encore le nouveau mot de passe
        <input name="password_confirm" data-pass type="password" required minlength="4" maxlength="200" autocomplete="new-password">
      </label>
      <label class="check"><input class="js-show-pass" type="checkbox"> Afficher les mots de passe</label>
      <button class="primary" type="submit">Enregistrer</button>
    </form>
  `;
}

function panelTitle() {
  if (state.mode === "add") return "Ajouter un proche";
  if (state.mode === "edit") return "Corriger la fiche";
  if (state.mode === "review") return "À valider";
  if (state.mode === "invite") return "Inviter";
  if (state.mode === "members") return "Membres";
  if (state.mode === "account") return "Mon accès";
  const person = personById(state.selectedId);
  return person ? fullName(person) : "Fiche";
}

function panelBody() {
  if (state.mode === "add") return addForm();
  if (state.mode === "edit") return editForm();
  if (state.mode === "review") return reviewView();
  if (state.mode === "invite") return inviteView();
  if (state.mode === "members") return membersView();
  if (state.mode === "account") return accountView();
  const person = personById(state.selectedId);
  return person ? personView(person) : "<p>Choisissez une personne dans l'arbre.</p>";
}

function panel() {
  return `
    <div class="panel-head">
      <h2>${esc(panelTitle())}</h2>
      <button type="button" class="ghost tiny" data-action="close-panel">Fermer</button>
    </div>
    <div class="panel-body ${!state.mode && personById(state.selectedId) ? "is-fiche" : ""}">
      <p class="form-error hidden"></p>
      ${panelBody()}
    </div>
  `;
}

function shell() {
  const open = Boolean(state.mode || state.selectedId);
  return `
    <div class="shell ${open ? "panel-open" : ""}">
      <header class="top">
        <div class="brand">
          ${logo()}
          <div>
            <div class="brand-name">Racine</div>
            <div class="brand-sub">L'arbre de la famille</div>
          </div>
        </div>
        <label class="search">
          <input id="search" type="search" placeholder="Rechercher" value="${esc(state.query)}" aria-label="Rechercher une personne" autocomplete="off">
        </label>
        <div class="legend" aria-hidden="true">
          <span><i class="swatch ok"></i> Validé</span>
          <span><i class="swatch wait"></i> En attente</span>
        </div>
        <label class="toggle"><input id="show-pending" type="checkbox" ${state.showPending ? "checked" : ""}> Voir les propositions</label>
        <div class="toolbar">${headerButtons()}</div>
      </header>
      <div class="workspace">
        <main class="board-wrap">${boardHtml()}</main>
        ${open ? `<aside class="panel" aria-label="Détail">${panel()}</aside>` : ""}
      </div>
      <div class="toast ${state.toast ? "" : "hidden"}" role="status">${esc(state.toast)}</div>
    </div>
  `;
}

function render() {
  if (!state.keepScroll) saveScroll();
  state.keepScroll = false;
  document.getElementById("app").innerHTML = state.me ? shell() : gate();
  requestAnimationFrame(afterRender);
}

function afterRender() {
  syncAddForm();
  const auto = document.querySelector("[autofocus]");
  if (auto) auto.focus();
  const board = document.getElementById("board");
  if (!board) return;
  if (state.scrollCardId) {
    const card = board.querySelector(`.card[data-id="${state.scrollCardId}"]`);
    state.scrollCardId = null;
    if (card) card.scrollIntoView({ block: "center", inline: "center" });
    return;
  }
  if (!state.didCenter) {
    state.didCenter = true;
    const scale = document.querySelector(".board-scale");
    const padTop = scale ? parseFloat(getComputedStyle(scale).paddingTop) || 0 : 0;
    board.scrollLeft = Math.max(0, (board.scrollWidth - board.clientWidth) / 2);
    board.scrollTop = Math.max(0, padTop - 28);
    return;
  }
  board.scrollLeft = state.scrollLeft || 0;
  board.scrollTop = state.scrollTop || 0;
}

function syncAddForm() {
  const kindEl = document.getElementById("kind");
  if (!kindEl || kindEl.tagName !== "SELECT") return;
  const kind = kindEl.value;
  document.getElementById("anchor-field")?.classList.toggle("hidden", kind === "root");
  document.getElementById("hint-root")?.classList.toggle("hidden", kind !== "root");
  document.getElementById("hint-sibling")?.classList.toggle("hidden", kind !== "sibling_of");
  const box = document.getElementById("also-parents");
  if (box) box.innerHTML = kind === "child_of" ? alsoParentsHTML(document.getElementById("anchor")?.value) : "";
}

function prefersStill() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function captureMotion() {
  const inner = document.querySelector(".board-inner");
  if (!inner) return null;
  const cards = {};
  inner.querySelectorAll(".card").forEach((card) => {
    const rect = card.getBoundingClientRect();
    cards[card.dataset.id] = { html: card.outerHTML, x: rect.left, y: rect.top };
  });
  const svg = inner.querySelector("svg");
  return { cards, svg: svg ? svg.outerHTML : "" };
}

function refreshPanel(resetScroll) {
  const aside = document.querySelector(".panel");
  const workspace = document.querySelector(".workspace");
  const shell = document.querySelector(".shell");
  if (!workspace || !shell) return false;
  const open = Boolean(state.mode || state.selectedId);
  shell.classList.toggle("panel-open", open);
  if (!open) {
    aside?.remove();
    return true;
  }
  if (!aside) {
    workspace.insertAdjacentHTML("beforeend", `<aside class="panel" aria-label="Détail">${panel()}</aside>`);
    return true;
  }
  const scroll = resetScroll ? 0 : aside.scrollTop;
  aside.innerHTML = panel();
  aside.scrollTop = scroll;
  return true;
}

function playMotion(previous, anchorId, fadeOnly) {
  const inner = document.querySelector(".board-inner");
  if (!inner || !previous || prefersStill()) return;
  inner.querySelectorAll(".is-ghost").forEach((node) => node.remove());
  const zoom = state.zoom || 1;
  const anchor = anchorId ? inner.querySelector(`.card[data-id="${anchorId}"]`) : null;
  const anchorPoint = anchor ? anchor.getBoundingClientRect() : null;

  inner.querySelectorAll(".card").forEach((card) => {
    const id = card.dataset.id;
    const old = previous.cards[id];
    if (id === String(anchorId)) return;
    if (!old) {
      const now = card.getBoundingClientRect();
      const dist = anchorPoint ? Math.hypot(now.left - anchorPoint.left, now.top - anchorPoint.top) : 0;
      card.animate(
        [{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 560, delay: Math.min(220, dist / 8), easing: "ease-out", fill: "both" },
      );
      return;
    }
    if (fadeOnly) return;
    const now = card.getBoundingClientRect();
    const dx = (old.x - now.left) / zoom;
    const dy = (old.y - now.top) / zoom;
    if (Math.hypot(dx, dy) < 2) return;
    card.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
      { duration: 560, easing: "cubic-bezier(.22, .8, .24, 1)", fill: "both" },
    );
  });

  Object.entries(previous.cards).forEach(([id, old]) => {
    if (inner.querySelector(`.card[data-id="${id}"]`)) return;
    const holder = document.createElement("div");
    holder.innerHTML = old.html;
    const ghost = holder.firstElementChild;
    if (!ghost) return;
    const origin = inner.getBoundingClientRect();
    ghost.classList.add("is-ghost");
    ghost.style.left = `${(old.x - origin.left) / zoom}px`;
    ghost.style.top = `${(old.y - origin.top) / zoom}px`;
    ghost.style.pointerEvents = "none";
    inner.appendChild(ghost);
    ghost.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 420, easing: "ease-in", fill: "forwards" },
    ).onfinish = () => ghost.remove();
  });

  const svg = inner.querySelector("svg");
  if (svg) {
    svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 640, easing: "ease-out", fill: "both" });
  }
  if (previous.svg) {
    const holder = document.createElement("div");
    holder.innerHTML = previous.svg;
    const ghost = holder.firstElementChild;
    if (ghost) {
      ghost.classList.add("is-ghost");
      ghost.style.pointerEvents = "none";
      inner.insertBefore(ghost, inner.firstChild);
      ghost.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: 460, easing: "ease-in", fill: "forwards" },
      ).onfinish = () => ghost.remove();
    }
  }
}

function framedZoom(layoutWidth, layoutHeight, board) {
  if (!board || !layoutWidth || !layoutHeight) return state.zoom;
  const availW = Math.max(140, board.clientWidth - 36);
  const availH = Math.max(140, board.clientHeight - 36);
  const fit = Math.min(availW / layoutWidth, availH / layoutHeight);
  const next = Math.round(Math.min(1, Math.max(0.05, fit)) * 100) / 100;
  if (fit < state.zoom - 0.03) return next;
  if (state.zoom < 1 && fit > state.zoom + 0.16) return Math.min(1, next);
  return state.zoom;
}

function stopGlide() {
  if (!state.glide) return;
  state.glide.cancelled = true;
  if (state.glide.zoom) state.zoom = state.glide.zoom;
  state.glide = null;
}

function scrollForZoom(zoom, width, height, anchor, board, scale) {
  const padLeft = parseFloat(getComputedStyle(scale).paddingLeft) || 0;
  const padTop = parseFloat(getComputedStyle(scale).paddingTop) || 0;
  const ax = anchor ? anchor.offsetLeft + anchor.offsetWidth / 2 : width / 2;
  const ay = anchor ? anchor.offsetTop + anchor.offsetHeight / 2 : height / 2;
  const left = padLeft + ax * zoom - board.clientWidth / 2;
  const top = padTop + ay * zoom - board.clientHeight * 0.42;
  const maxLeft = Math.max(0, padLeft * 2 + width * zoom - board.clientWidth);
  const maxTop = Math.max(0, padTop * 2 + height * zoom - board.clientHeight);
  return {
    left: Math.min(maxLeft, Math.max(0, left)),
    top: Math.min(maxTop, Math.max(0, top)),
  };
}

function applyZoomBox(zoom, width, height, inner, scale) {
  inner.style.transform = `scale(${zoom})`;
  scale.style.width = `${width * zoom}px`;
  scale.style.height = `${height * zoom}px`;
  const label = document.querySelector(".zoom-label");
  if (label) label.textContent = `${Math.round(zoom * 100)} %`;
}

function glideZoom(startZoom, endZoom, width, height, anchor, board, inner, scale) {
  stopGlide();
  const glide = { cancelled: false };
  state.glide = glide;
  const startLeft = board.scrollLeft;
  const startTop = board.scrollTop;
  const end = scrollForZoom(endZoom, width, height, anchor, board, scale);
  applyZoomBox(startZoom, width, height, inner, scale);
  const started = performance.now();
  const duration = 640;
  function frame(now) {
    if (glide.cancelled) return;
    const progress = Math.min(1, (now - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    const zoom = startZoom + (endZoom - startZoom) * eased;
    glide.zoom = zoom;
    applyZoomBox(zoom, width, height, inner, scale);
    board.scrollLeft = startLeft + (end.left - startLeft) * eased;
    board.scrollTop = startTop + (end.top - startTop) * eased;
    if (progress < 1) requestAnimationFrame(frame);
    else state.glide = null;
  }
  requestAnimationFrame(frame);
}

function paintTree(anchorId) {
  const previous = captureMotion();
  const wrap = document.querySelector(".board-wrap");
  const boardBefore = document.getElementById("board");
  if (!wrap || !boardBefore) {
    state.scrollCardId = anchorId || null;
    render();
    return;
  }
  stopGlide();
  const graph = visibleGraph();
  const layout = graph.people.length ? layoutTree(graph.people, graph.relations) : null;
  const anchorBefore = anchorId && previous ? previous.cards[anchorId] : null;
  refreshPanel(true);
  const boardNow = document.getElementById("board") || boardBefore;
  const fromZoom = state.zoom;
  const toZoom = layout ? framedZoom(layout.width, layout.height, boardNow) : fromZoom;
  state.zoom = toZoom;
  wrap.innerHTML = boardHtml();
  const board = document.getElementById("board");
  const inner = document.querySelector(".board-inner");
  const scale = document.querySelector(".board-scale");
  const anchor = anchorId && inner ? inner.querySelector(`.card[data-id="${anchorId}"]`) : null;
  const width = inner ? Number(inner.dataset.w) : 0;
  const height = inner ? Number(inner.dataset.h) : 0;
  const zooming = !prefersStill() && Math.abs(toZoom - fromZoom) > 0.02 && inner && scale;
  if (zooming) {
    applyZoomBox(fromZoom, width, height, inner, scale);
    if (anchor && anchorBefore) {
      const now = anchor.getBoundingClientRect();
      board.scrollLeft += now.left - anchorBefore.x;
      board.scrollTop += now.top - anchorBefore.y;
    }
    playMotion(previous, anchorId, true);
    glideZoom(fromZoom, toZoom, width, height, anchor, board, inner, scale);
    return;
  }
  if (board && anchor && anchorBefore) {
    const now = anchor.getBoundingClientRect();
    board.scrollLeft += now.left - anchorBefore.x;
    board.scrollTop += now.top - anchorBefore.y;
  }
  playMotion(previous, anchorId, false);
}

function focusPerson(id) {
  const moving = Boolean(document.querySelector(".board-inner"));
  state.selectedId = id;
  state.centerId = id;
  state.mode = null;
  state.photoId = null;
  if (moving && state.view !== "all") {
    paintTree(id);
    return;
  }
  state.scrollCardId = id;
  render();
}

function openAdd(kind, anchorId) {
  state.mode = "add";
  state.addKind = kind;
  state.addAnchor = anchorId || null;
  if (anchorId) state.selectedId = anchorId;
  render();
}

function setZoom(next) {
  const zoom = Math.min(1.4, Math.max(0.08, Math.round(next * 100) / 100));
  state.zoom = zoom;
  const inner = document.querySelector(".board-inner");
  const scale = document.querySelector(".board-scale");
  if (!inner || !scale) return;
  const width = Number(inner.dataset.w);
  const height = Number(inner.dataset.h);
  inner.style.transform = `scale(${zoom})`;
  scale.style.width = `${width * zoom}px`;
  scale.style.height = `${height * zoom}px`;
  const label = document.querySelector(".zoom-label");
  if (label) label.textContent = `${Math.round(zoom * 100)} %`;
}

function fieldsFrom(form) {
  const data = new FormData(form);
  return {
    given_name: data.get("given_name"),
    family_name: data.get("family_name"),
    birth_date: data.get("birth_date"),
    death_date: data.get("death_date"),
    place: data.get("place"),
    notes: data.get("notes"),
  };
}

async function submitCode(form) {
  const data = new FormData(form);
  const result = await api("/api/code", {
    method: "POST",
    body: { code: data.get("code") },
  });
  state.me = result.user;
  state.needsSetup = false;
  state.mode = null;
  state.selectedId = null;
  state.didCenter = false;
  applyTree(await api("/api/tree"));
  render();
}

async function submitLogin(form) {
  const data = new FormData(form);
  const result = await api("/api/login", {
    method: "POST",
    body: { name: data.get("name"), password: data.get("password") },
  });
  state.me = result.user;
  state.needsSetup = false;
  state.mode = null;
  state.selectedId = null;
  state.didCenter = false;
  applyTree(await api("/api/tree"));
  render();
}

async function submitSetup(form) {
  const data = new FormData(form);
  const result = await api("/api/setup", {
    method: "POST",
    body: {
      name: data.get("name"),
      password: data.get("password"),
      password_confirm: data.get("password_confirm"),
    },
  });
  state.me = result.user;
  state.needsSetup = false;
  state.didCenter = false;
  applyTree(await api("/api/tree"));
  queueToast("L'arbre est créé. Ajoutez la première personne, puis invitez la famille.");
  render();
}

async function submitJoin(form) {
  const data = new FormData(form);
  const result = await api("/api/join", {
    method: "POST",
    body: {
      code: data.get("code"),
      name: data.get("name"),
      password: data.get("password"),
      password_confirm: data.get("password_confirm"),
    },
  });
  state.me = result.user;
  state.needsSetup = false;
  state.didCenter = false;
  applyTree(await api("/api/tree"));
  queueToast("Bienvenue. Vos ajouts seront visibles en teinte claire jusqu'à validation.");
  render();
}

async function submitAdd(form) {
  const kindEl = form.querySelector("#kind");
  const kind = kindEl ? kindEl.value : "root";
  const body = {
    ...fieldsFrom(form),
    kind,
    anchor_id: kind === "root" ? null : num(new FormData(form).get("anchor_id")),
    also_parent_ids: [...form.querySelectorAll('input[name="also"]:checked')].map((input) => Number(input.value)),
  };
  const data = applyTree(await api("/api/people", { method: "POST", body }));
  state.mode = null;
  state.selectedId = data.person.id;
  state.scrollCardId = data.person.id;
  queueToast(isAdmin()
    ? "Ajouté à l'arbre."
    : "Proposition ajoutée. Elle est visible en teinte claire.");
  render();
}

async function submitEdit(form) {
  const data = applyTree(await api(`/api/people/${state.selectedId}`, {
    method: "PATCH",
    body: fieldsFrom(form),
  }));
  state.mode = null;
  const person = personById(state.selectedId);
  const pending = person && (person.status === "pending" || proposalFor(person.id));
  queueToast(!isAdmin() && pending
    ? "Modification proposée. Elle apparaît en teinte claire."
    : "Fiche mise à jour.");
  render();
  return data;
}

async function submitAccount(form) {
  const data = new FormData(form);
  await api("/api/account/password", {
    method: "POST",
    body: {
      current_password: data.get("current_password"),
      new_password: data.get("new_password"),
      password_confirm: data.get("password_confirm"),
    },
  });
  state.mode = null;
  queueToast("Mot de passe modifié.");
  render();
}

async function submitMember(form) {
  const data = new FormData(form);
  applyTree(await api("/api/users", {
    method: "POST",
    body: { name: data.get("name"), password: data.get("password") },
  }));
  queueToast("Membre ajouté.");
  render();
}

async function submitReset(form) {
  const data = new FormData(form);
  applyTree(await api(`/api/users/${data.get("user_id")}/password`, {
    method: "POST",
    body: { password: data.get("password") },
  }));
  queueToast("Mot de passe mis à jour.");
  render();
}

async function submitLink(form) {
  const data = new FormData(form);
  applyTree(await api("/api/relations", {
    method: "POST",
    body: {
      person_id: num(data.get("person_id")),
      other_id: num(data.get("other_id")),
      role: data.get("role"),
    },
  }));
  queueToast(isAdmin() ? "Lien ajouté." : "Lien proposé. Il apparaît en teinte claire.");
  render();
}

function confirmRemovePerson(person) {
  if (!person) return false;
  if (person.status === "pending") return window.confirm("Retirer cette proposition ?");
  if (isAdmin()) {
    return window.confirm(`Retirer ${fullName(person)} de l'arbre ? Les liens vers cette fiche seront supprimés. Les autres personnes restent.`);
  }
  return window.confirm("Proposer la suppression ? La fiche reste visible, avec une teinte différente, jusqu'à la décision de l'administrateur.");
}

function confirmRemoveLink(relation) {
  if (!relation) return false;
  if (relation.status === "pending") return window.confirm("Retirer ce lien proposé ?");
  if (isAdmin()) return window.confirm("Retirer ce lien de l'arbre ?");
  if (relation.remove_proposed_by) return false;
  return window.confirm("Proposer le retrait de ce lien ? Il reste visible jusqu'à validation.");
}

async function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  state.lastForm = form;
  const errorBox = form.querySelector(".form-error");
  if (errorBox) {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }
  await run(async () => {
    if (form.id === "form-code") return submitCode(form);
    if (form.id === "form-login") return submitLogin(form);
    if (form.id === "form-setup") return submitSetup(form);
    if (form.id === "form-join") return submitJoin(form);
    if (form.id === "form-add") return submitAdd(form);
    if (form.id === "form-edit") return submitEdit(form);
    if (form.id === "form-account") return submitAccount(form);
    if (form.id === "form-member") return submitMember(form);
    if (form.dataset.form === "reset") return submitReset(form);
    if (form.dataset.form === "link") return submitLink(form);
  });
}

function onInput(event) {
  if (event.target.id !== "search") return;
  state.query = event.target.value;
  const query = state.query.trim().toLocaleLowerCase("fr-FR");
  document.querySelectorAll(".card").forEach((card) => {
    const blob = (card.dataset.search || "").toLocaleLowerCase("fr-FR");
    const match = !query || blob.includes(query);
    card.classList.toggle("dimmed", Boolean(query) && !match);
    card.classList.toggle("matched", Boolean(query) && match);
  });
}

function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const max = 1400;
      const scale = Math.min(1, max / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Cette photo ne peut pas être lue."));
    };
    image.src = url;
  });
}

function onChange(event) {
  if (event.target.id === "show-pending") {
    state.showPending = event.target.checked;
    if (document.querySelector(".board-inner")) {
      paintTree(state.centerId || state.selectedId);
      return;
    }
    render();
    return;
  }
  if (event.target.classList.contains("js-photo")) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file || !state.selectedId) return;
    const personId = state.selectedId;
    run(async () => {
      const image = await readPhoto(file);
      applyTree(await api(`/api/people/${personId}/photos`, { method: "POST", body: { image } }));
      state.keepScroll = true;
      queueToast("Photo ajoutée.");
      render();
    });
    return;
  }
  if (event.target.classList.contains("js-show-pass")) {
    const scope = event.target.closest("form") || document;
    scope.querySelectorAll("[data-pass]").forEach((input) => {
      input.type = event.target.checked ? "text" : "password";
    });
    return;
  }
  if (event.target.id === "kind" || event.target.id === "anchor") syncAddForm();
}

async function onClick(event) {
  if (state.suppressClick) {
    state.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) {
    const card = event.target.closest(".card");
    if (card) focusPerson(Number(card.dataset.id));
    return;
  }
  const action = button.dataset.action;
  if (action === "gate-tab") {
    state.gate = button.dataset.tab;
    render();
    return;
  }
  if (action === "add-open") {
    openAdd(state.selectedId ? "child_of" : "root", state.selectedId);
    return;
  }
  if (action === "add-child") return openAdd("child_of", state.selectedId);
  if (action === "add-parent") return openAdd("parent_of", state.selectedId);
  if (action === "add-spouse") return openAdd("spouse_of", state.selectedId);
  if (action === "add-sibling") return openAdd("sibling_of", state.selectedId);
  if (action === "edit-open") {
    state.mode = "edit";
    render();
    return;
  }
  if (action === "open-review") {
    state.mode = "review";
    render();
    return;
  }
  if (action === "open-invite") {
    state.mode = "invite";
    render();
    return;
  }
  if (action === "open-members") {
    state.mode = "members";
    render();
    return;
  }
  if (action === "open-account") {
    state.mode = "account";
    render();
    return;
  }
  if (action === "close-panel") {
    state.mode = null;
    state.selectedId = null;
    state.photoId = null;
    render();
    return;
  }
  if (action === "set-view") {
    state.view = button.dataset.view === "all" ? "all" : "around";
    state.didCenter = false;
    if (state.view === "around" && !state.centerId && state.people.length) {
      state.centerId = state.selectedId || state.people[0].id;
    }
    if (document.querySelector(".board-inner")) {
      paintTree(state.centerId || state.selectedId);
      return;
    }
    render();
    return;
  }
  if (action === "pick-photo") {
    document.querySelector(".js-photo")?.click();
    return;
  }
  if (action === "open-photo") {
    state.photoId = Number(button.dataset.id);
    if (refreshPanel()) return;
    render();
    return;
  }
  if (action === "close-photo") {
    state.photoId = null;
    if (refreshPanel()) return;
    render();
    return;
  }
  if (action === "cover-photo") {
    await run(async () => {
      applyTree(await api(`/api/photos/${button.dataset.id}/cover`, { method: "POST" }));
      state.keepScroll = true;
      queueToast("Cette photo est sur la tuile.");
      render();
    });
    return;
  }
  if (action === "delete-photo") {
    if (!window.confirm("Retirer cette photo ?")) return;
    await run(async () => {
      applyTree(await api(`/api/photos/${button.dataset.id}`, { method: "DELETE" }));
      if (state.photoId === Number(button.dataset.id)) state.photoId = null;
      state.keepScroll = true;
      queueToast("Photo retirée.");
      render();
    });
    return;
  }
  if (action === "cancel-form") {
    state.mode = null;
    render();
    return;
  }
  if (action === "focus-person") {
    focusPerson(Number(button.dataset.id));
    return;
  }
  if (action === "zoom-in") return setZoom(state.zoom + 0.1);
  if (action === "zoom-out") return setZoom(state.zoom - 0.1);
  if (action === "zoom-fit") {
    const board = document.getElementById("board");
    const inner = document.querySelector(".board-inner");
    if (!board || !inner) return;
    const fitted = Math.min(1, (board.clientWidth - 24) / Number(inner.dataset.w));
    setZoom(Math.max(0.08, fitted));
    return;
  }
  if (action === "copy-code") {
    try {
      await navigator.clipboard.writeText(state.familyCode);
      flash("Code copié.");
    } catch {
      flash("Sélectionnez le code pour le copier.");
    }
    return;
  }
  if (action === "logout") {
    await run(async () => {
      await api("/api/logout", { method: "POST" });
      state.me = null;
      state.people = [];
      state.relations = [];
      state.proposals = [];
      state.users = [];
      state.selectedId = null;
      state.mode = null;
      state.query = "";
      state.didCenter = false;
      state.needsSetup = false;
      render();
    });
    return;
  }
  if (action === "regen-code") {
    if (!window.confirm("Créer un nouveau code ? L'ancien ne fonctionnera plus.")) return;
    await run(async () => {
      applyTree(await api("/api/family-code", { method: "POST" }));
      queueToast("Nouveau code créé.");
      render();
    });
    return;
  }
  if (action === "promote" || action === "demote") {
    const role = action === "promote" ? "admin" : "member";
    await run(async () => {
      applyTree(await api(`/api/users/${button.dataset.id}/role`, { method: "POST", body: { role } }));
      queueToast(role === "admin" ? "Cette personne peut maintenant valider." : "Droit d'administration retiré.");
      render();
    });
    return;
  }
  if (action === "review") {
    const reviewAction = button.dataset.reviewAction;
    if (reviewAction === "reject" && !window.confirm("Refuser cette proposition ? Elle disparaîtra de l'arbre.")) return;
    await run(async () => {
      applyTree(await api("/api/review", {
        method: "POST",
        body: {
          action: reviewAction,
          kind: button.dataset.kind,
          id: Number(button.dataset.id),
        },
      }));
      queueToast(reviewAction === "approve"
        ? "Validé. C'est maintenant affiché comme le reste de l'arbre."
        : "Proposition refusée.");
      render();
    });
    return;
  }
  if (action === "remove-link") {
    const relation = state.relations.find((item) => item.id === Number(button.dataset.id));
    if (!confirmRemoveLink(relation)) return;
    await run(async () => {
      const data = applyTree(await api(`/api/relations/${button.dataset.id}`, { method: "DELETE" }));
      queueToast(data.result === "proposed"
        ? "Retrait proposé. Le lien reste visible en teinte différente."
        : "Lien retiré.");
      render();
    });
    return;
  }
  if (action === "cancel-removal") {
    await run(async () => {
      applyTree(await api(`/api/relations/${button.dataset.id}/cancel-removal`, { method: "POST" }));
      queueToast("Retrait annulé.");
      render();
    });
    return;
  }
  if (action === "delete-person") {
    const person = personById(Number(button.dataset.id));
    if (!confirmRemovePerson(person)) return;
    await run(async () => {
      const data = applyTree(await api(`/api/people/${button.dataset.id}`, { method: "DELETE" }));
      queueToast(data.result === "proposed"
        ? "Suppression proposée. La fiche reste visible en teinte différente."
        : "Fiche retirée.");
      render();
    });
    return;
  }
  if (action === "withdraw-proposal") {
    if (!window.confirm("Retirer cette proposition ?")) return;
    await run(async () => {
      applyTree(await api(`/api/proposals/${button.dataset.id}`, { method: "DELETE" }));
      queueToast("Proposition retirée.");
      render();
    });
  }
}

async function boot() {
  try {
    const status = await api("/api/status");
    state.needsSetup = status.needs_setup;
    state.me = status.user;
    if (state.me) {
      applyTree(await api("/api/tree"));
    }
    render();
  } catch (error) {
    document.getElementById("app").innerHTML = wrapGate(`<h1>Racine</h1><p class="form-error">${esc(error.message)}</p>`);
  }
}

let pan = null;

function onPointerDown(event) {
  if (event.button !== 0 || event.pointerType === "touch") return;
  const board = event.target.closest("#board");
  if (!board) return;
  if (event.target.closest("button, a, input, select, textarea, label, summary")) return;
  stopGlide();
  pan = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: board.scrollLeft,
    top: board.scrollTop,
    moved: false,
    board,
  };
}

function onPointerMove(event) {
  if (!pan || event.pointerId !== pan.id) return;
  const dx = event.clientX - pan.x;
  const dy = event.clientY - pan.y;
  if (!pan.moved && Math.hypot(dx, dy) < 5) return;
  pan.moved = true;
  pan.board.classList.add("is-panning");
  pan.board.scrollLeft = pan.left - dx;
  pan.board.scrollTop = pan.top - dy;
}

function onPointerUp(event) {
  if (!pan || event.pointerId !== pan.id) return;
  pan.board.classList.remove("is-panning");
  if (pan.moved) state.suppressClick = true;
  pan = null;
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  root.addEventListener("click", onClick);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.id === "search") {
      event.preventDefault();
      const query = state.query.trim().toLocaleLowerCase("fr-FR");
      if (!query) return;
      const match = state.people.find((person) => (
        `${fullName(person)} ${person.place || ""}`.toLocaleLowerCase("fr-FR").includes(query)
      ));
      if (match) focusPerson(match.id);
      return;
    }
    if (event.key === "Enter" && event.target.classList?.contains("card")) {
      focusPerson(Number(event.target.dataset.id));
    }
  });
  boot();
});
