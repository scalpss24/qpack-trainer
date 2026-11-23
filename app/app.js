import {
  defaultProgress,
  deletePackage,
  exportProgressBackup,
  getAllPackages,
  getAllProgressMap,
  getImageBlob,
  getPackage,
  importProgressBackup,
  savePackage,
  saveProgressRecord,
} from "./db.js";
import { readQpackArchive } from "./zip.js";

const mainEl = document.getElementById("main-content");
const titleEl = document.getElementById("topbar-title");
const btnBack = document.getElementById("btn-back");
const btnTheme = document.getElementById("btn-theme");
const btnBackup = document.getElementById("btn-backup");
const inputQpack = document.getElementById("input-qpack");
const inputBackup = document.getElementById("input-backup");
const modalBackup = document.getElementById("modal-backup");
const btnCloseBackup = document.getElementById("btn-close-backup");
const btnExportProgress = document.getElementById("btn-export-progress");
const btnCopyProgress = document.getElementById("btn-copy-progress");
const btnImportProgress = document.getElementById("btn-import-progress");
const backupStatus = document.getElementById("backup-status");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const toastEl = document.getElementById("toast");

const state = {
  view: "packages", // 'packages' | 'categories' | 'trainer' | 'summary'
  packages: [],
  progressMap: new Map(),
  activePackage: null,
  filterMode: "all", // 'all' | 'unseen' | 'mistake' | 'favorite'
  shuffleQuestions: true,
  shuffleOptions: true,
  sessionQuestions: [],
  sessionIndex: 0,
  sessionCorrect: 0,
  sessionWrong: 0,
  answeredCurrent: false,
  selectedOptionIds: new Set(),
  shuffledCurrentOptions: [],
  flashcardRevealed: false,
  activeObjectUrls: [],
};

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add("hidden"), 2800);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function revokeObjectUrls() {
  for (const url of state.activeObjectUrls) {
    URL.revokeObjectURL(url);
  }
  state.activeObjectUrls = [];
}

function guessMime(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

async function importQpackFile(file) {
  try {
    showToast(`Импорт ${file.name}...`);
    const ab = await file.arrayBuffer();
    const filesMap = await readQpackArchive(ab);
    const manifestBytes = filesMap.get("manifest.json");
    if (!manifestBytes) {
      throw new Error("Внутри .qpack отсутствует manifest.json");
    }
    const manifest = JSON.parse(new TextDecoder("utf-8").decode(manifestBytes));
    if (!manifest.package_id || !Array.isArray(manifest.questions)) {
      throw new Error("Некорректная структура manifest.json");
    }

    const imageEntries = [];
    for (const [relPath, bytes] of filesMap.entries()) {
      if (relPath !== "manifest.json" && relPath.startsWith("images/")) {
        imageEntries.push([relPath, new Blob([bytes], { type: guessMime(relPath) })]);
      }
    }

    await savePackage(manifest, imageEntries);
    await refreshData();
    showToast(`Импортировано: ${manifest.title} (${manifest.questions.length} вопр.)`);
  } catch (err) {
    console.error(err);
    showToast(`Ошибка: ${err.message}`);
  }
}

async function refreshData() {
  state.packages = await getAllPackages();
  state.progressMap = await getAllProgressMap();
  if (state.activePackage) {
    state.activePackage = await getPackage(state.activePackage.package_id);
  }
  render();
}

function computeStats(questions) {
  let learned = 0;
  let mistake = 0;
  let unseen = 0;
  let favorite = 0;
  for (const q of questions) {
    const p = state.progressMap.get(q.id);
    if (!p || p.status === "unseen") unseen++;
    else if (p.status === "learned") learned++;
    else if (p.status === "mistake") mistake++;
    if (p && p.is_favorite) favorite++;
  }
  return { total: questions.length, learned, mistake, unseen, favorite };
}

function filterQuestions(questions) {
  return questions.filter((q) => {
    const p = state.progressMap.get(q.id);
    if (state.filterMode === "unseen") return !p || p.status === "unseen";
    if (state.filterMode === "mistake") return p && p.status === "mistake";
    if (state.filterMode === "favorite") return p && p.is_favorite;
    return true;
  });
}

function startSession(questions) {
  const filtered = filterQuestions(questions);
  if (filtered.length === 0) {
    showToast("Нет вопросов для выбранного фильтра");
    return;
  }
  state.sessionQuestions = state.shuffleQuestions ? shuffleArray(filtered) : [...filtered];
  state.sessionIndex = 0;
  state.sessionCorrect = 0;
  state.sessionWrong = 0;
  prepareQuestionState();
  state.view = "trainer";
  render();
}

function prepareQuestionState() {
  revokeObjectUrls();
  state.answeredCurrent = false;
  state.selectedOptionIds = new Set();
  state.flashcardRevealed = false;
  const q = state.sessionQuestions[state.sessionIndex];
  if (q && q.type !== "flashcard") {
    state.shuffledCurrentOptions = state.shuffleOptions
      ? shuffleArray(q.options || [])
      : [...(q.options || [])];
  } else {
    state.shuffledCurrentOptions = [];
  }
}

function renderPackagesView() {
  titleEl.textContent = "QPack Тренажёр";
  btnBack.classList.add("hidden");

  const pkgHtml = state.packages.length
    ? state.packages
        .map((pkg) => {
          const st = computeStats(pkg.questions || []);
          const pct = st.total ? Math.round((st.learned / st.total) * 100) : 0;
          return `
            <div class="card pkg-card" data-open-pkg="${escapeHtml(pkg.package_id)}">
              <div class="row">
                <h2 class="pkg-title">${escapeHtml(pkg.title)}</h2>
                <button class="btn btn-secondary btn-sm" data-del-pkg="${escapeHtml(pkg.package_id)}" title="Удалить пакет">🗑</button>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <div class="pills">
                <span class="pill">Всего: ${st.total}</span>
                <span class="pill ok">Выучено: ${st.learned} (${pct}%)</span>
                <span class="pill err">Ошибки: ${st.mistake}</span>
                <span class="pill fav">★ ${st.favorite}</span>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="card muted">Пока нет загруженных пакетов. Импортируйте файл <code>.qpack</code>, созданный конвертером.</div>`;

  mainEl.innerHTML = `
    <div id="dropzone" class="dropzone">
      <div style="font-weight:600;margin-bottom:6px;">Загрузить пакет тестов (.qpack)</div>
      <div class="muted" style="margin-bottom:12px;">Перетащите файл сюда или выберите на устройстве</div>
      <button id="btn-pick-qpack" class="btn btn-primary">Выбрать .qpack файл</button>
    </div>
    ${pkgHtml}
  `;

  document.getElementById("btn-pick-qpack").addEventListener("click", () => inputQpack.click());

  const dz = document.getElementById("dropzone");
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) importQpackFile(file);
  });

  mainEl.querySelectorAll("[data-open-pkg]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-del-pkg]")) return;
      const pkgId = el.dataset.openPkg;
      state.activePackage = state.packages.find((p) => p.package_id === pkgId);
      state.view = "categories";
      render();
    });
  });

  mainEl.querySelectorAll("[data-del-pkg]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pkgId = btn.dataset.delPkg;
      if (confirm("Удалить пакет? Ваш прогресс и заметки сохранятся в базе.")) {
        await deletePackage(pkgId);
        await refreshData();
        showToast("Пакет удалён");
      }
    });
  });
}

function renderCategoriesView() {
  const pkg = state.activePackage;
  if (!pkg) {
    state.view = "packages";
    return render();
  }
  titleEl.textContent = pkg.title;
  btnBack.classList.remove("hidden");

  const allQs = pkg.questions || [];
  const allStats = computeStats(allQs);

  const modes = [
    { id: "all", label: `Все (${allStats.total})` },
    { id: "unseen", label: `Новые (${allStats.unseen})` },
    { id: "mistake", label: `Ошибки (${allStats.mistake})` },
    { id: "favorite", label: `Избранное (${allStats.favorite})` },
  ];

  const catsHtml = (pkg.categories || [])
    .map((cat) => {
      const catQs = allQs.filter((q) => q.category_id === cat.id);
      const st = computeStats(catQs);
      const pct = st.total ? Math.round((st.learned / st.total) * 100) : 0;
      const matchingCount = filterQuestions(catQs).length;
      return `
        <div class="card pkg-card" data-start-cat="${escapeHtml(cat.id)}">
          <div class="row">
            <div style="font-weight:600;">${escapeHtml(cat.title)}</div>
            <span class="pill">${matchingCount} / ${st.total}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="pills">
            <span class="pill ok">Выучено: ${st.learned}</span>
            <span class="pill err">Ошибки: ${st.mistake}</span>
            <span class="pill fav">★ ${st.favorite}</span>
          </div>
        </div>
      `;
    })
    .join("");

  mainEl.innerHTML = `
    <div class="card">
      <div class="filter-chips">
        ${modes
          .map(
            (m) =>
              `<button class="chip ${state.filterMode === m.id ? "active" : ""}" data-filter="${m.id}">${m.label}</button>`
          )
          .join("")}
      </div>
      <label class="toggle-row">
        <span>Перемешивать вопросы</span>
        <input id="chk-shuffle-q" type="checkbox" ${state.shuffleQuestions ? "checked" : ""} />
      </label>
      <label class="toggle-row">
        <span>Перемешивать варианты ответов</span>
        <input id="chk-shuffle-o" type="checkbox" ${state.shuffleOptions ? "checked" : ""} />
      </label>
      <button id="btn-start-all" class="btn btn-primary" style="margin-top:10px;">
        Тренировать весь пакет (${filterQuestions(allQs).length})
      </button>
    </div>
    ${catsHtml}
  `;

  mainEl.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filterMode = btn.dataset.filter;
      render();
    });
  });

  document.getElementById("chk-shuffle-q").addEventListener("change", (e) => {
    state.shuffleQuestions = e.target.checked;
  });
  document.getElementById("chk-shuffle-o").addEventListener("change", (e) => {
    state.shuffleOptions = e.target.checked;
  });

  document.getElementById("btn-start-all").addEventListener("click", () => {
    startSession(allQs);
  });

  mainEl.querySelectorAll("[data-start-cat]").forEach((card) => {
    card.addEventListener("click", () => {
      const catId = card.dataset.startCat;
      const catQs = allQs.filter((q) => q.category_id === catId);
      startSession(catQs);
    });
  });
}

async function recordAnswer(questionId, isCorrect) {
  const prev = state.progressMap.get(questionId) || defaultProgress(questionId);
  const updated = {
    ...prev,
    status: isCorrect ? "learned" : "mistake",
    attempts_count: (prev.attempts_count || 0) + 1,
    correct_count: (prev.correct_count || 0) + (isCorrect ? 1 : 0),
    last_answered_at: new Date().toISOString(),
  };
  state.progressMap.set(questionId, updated);
  await saveProgressRecord(updated);
  if (isCorrect) state.sessionCorrect++;
  else state.sessionWrong++;
}

async function renderTrainerView() {
  const q = state.sessionQuestions[state.sessionIndex];
  if (!q) {
    state.view = "summary";
    return render();
  }

  titleEl.textContent = `Вопрос ${state.sessionIndex + 1} из ${state.sessionQuestions.length}`;
  btnBack.classList.remove("hidden");

  const prog = state.progressMap.get(q.id) || defaultProgress(q.id);
  const pct = Math.round(((state.sessionIndex + 1) / state.sessionQuestions.length) * 100);
  const statusLabels = { unseen: "Новый", learned: "Выучен", mistake: "Ошибка" };
  const statusClass = prog.status === "learned" ? "ok" : prog.status === "mistake" ? "err" : "";

  let bodyHtml = "";
  if (q.type === "flashcard") {
    const ansText = q.options && q.options[0] ? q.options[0].text : "Эталонный ответ не указан";
    bodyHtml = state.flashcardRevealed
      ? `
        <div class="flashcard-answer">${escapeHtml(ansText)}</div>
        ${
          !state.answeredCurrent
            ? `<div class="nav-footer">
                <button id="btn-fc-wrong" class="btn btn-danger">Повторить (Ошибка)</button>
                <button id="btn-fc-ok" class="btn btn-success">Знаю (Выучен)</button>
               </div>`
            : ""
        }
      `
      : `<button id="btn-fc-reveal" class="btn btn-primary">Показать ответ</button>`;
  } else {
    const isMulti = q.type === "multiple_choice";
    const optsHtml = state.shuffledCurrentOptions
      .map((opt, idx) => {
        let cls = "opt-btn";
        if (state.answeredCurrent) {
          if (opt.is_correct) cls += " correct";
          else if (state.selectedOptionIds.has(opt.id)) cls += " wrong";
        } else if (state.selectedOptionIds.has(opt.id)) {
          cls += " selected";
        }
        return `
          <button class="${cls}" data-opt-id="${escapeHtml(opt.id)}" ${state.answeredCurrent ? "disabled" : ""}>
            <span style="opacity:0.6;font-weight:600;">${idx + 1}.</span>
            <span>${escapeHtml(opt.text)}</span>
          </button>
        `;
      })
      .join("");

    bodyHtml = `
      <div class="stack">${optsHtml}</div>
      ${
        isMulti && !state.answeredCurrent
          ? `<button id="btn-check-multi" class="btn btn-primary" style="margin-top:12px;">Проверить (несколько ответов)</button>`
          : ""
      }
    `;
  }

  const explHtml =
    state.answeredCurrent && q.explanation
      ? `<div class="card" style="margin-top:12px;background:var(--surface-2);"><strong>Пояснение:</strong> ${escapeHtml(q.explanation)}</div>`
      : "";

  mainEl.innerHTML = `
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="card">
      <div class="q-meta">
        <span class="pill ${statusClass}">${statusLabels[prog.status] || "Новый"}</span>
        <button id="btn-fav" class="fav-btn ${prog.is_favorite ? "active" : ""}" title="В избранное">
          ${prog.is_favorite ? "★ В избранном" : "☆ В избранное"}
        </button>
      </div>
      <div class="q-text">${escapeHtml(q.text)}</div>
      <div id="q-images" class="q-images"></div>
      ${bodyHtml}
      ${explHtml}
      <details style="margin-top:14px;" ${prog.user_note ? "open" : ""}>
        <summary class="muted" style="cursor:pointer;">Личная заметка / шпаргалка</summary>
        <textarea id="txt-note" class="note-box" placeholder="Напишите свою подсказку...">${escapeHtml(prog.user_note || "")}</textarea>
      </details>
    </div>
    <div class="nav-footer">
      <button id="btn-prev-q" class="btn btn-secondary" ${state.sessionIndex === 0 ? "disabled" : ""}>← Назад</button>
      <button id="btn-next-q" class="btn btn-primary">
        ${state.sessionIndex + 1 >= state.sessionQuestions.length ? "Завершить" : "Далее →"}
      </button>
    </div>
  `;

  // Load images asynchronously from IndexedDB
  const imgContainer = document.getElementById("q-images");
  if (q.images && q.images.length && state.activePackage) {
    for (const relPath of q.images) {
      const blob = await getImageBlob(state.activePackage.package_id, relPath);
      if (blob) {
        const url = URL.createObjectURL(blob);
        state.activeObjectUrls.push(url);
        const img = document.createElement("img");
        img.src = url;
        img.alt = "Иллюстрация к вопросу";
        img.addEventListener("click", () => {
          lightboxImg.src = url;
          lightbox.classList.remove("hidden");
        });
        imgContainer.appendChild(img);
      }
    }
  }

  // Favorite toggle
  document.getElementById("btn-fav").addEventListener("click", async () => {
    const cur = state.progressMap.get(q.id) || defaultProgress(q.id);
    const updated = { ...cur, is_favorite: !cur.is_favorite };
    state.progressMap.set(q.id, updated);
    await saveProgressRecord(updated);
    render();
  });

  // Note autosave
  const noteEl = document.getElementById("txt-note");
  let noteTimer = null;
  noteEl.addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      const cur = state.progressMap.get(q.id) || defaultProgress(q.id);
      const updated = { ...cur, user_note: noteEl.value };
      state.progressMap.set(q.id, updated);
      await saveProgressRecord(updated);
    }, 350);
  });

  // Options handling
  if (q.type === "flashcard") {
    const revealBtn = document.getElementById("btn-fc-reveal");
    if (revealBtn) {
      revealBtn.addEventListener("click", () => {
        state.flashcardRevealed = true;
        render();
      });
    }
    const okBtn = document.getElementById("btn-fc-ok");
    if (okBtn) {
      okBtn.addEventListener("click", async () => {
        state.answeredCurrent = true;
        await recordAnswer(q.id, true);
        goNextQuestion();
      });
    }
    const wrongBtn = document.getElementById("btn-fc-wrong");
    if (wrongBtn) {
      wrongBtn.addEventListener("click", async () => {
        state.answeredCurrent = true;
        await recordAnswer(q.id, false);
        goNextQuestion();
      });
    }
  } else if (q.type === "single_choice") {
    mainEl.querySelectorAll("[data-opt-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (state.answeredCurrent) return;
        const optId = btn.dataset.optId;
        state.selectedOptionIds = new Set([optId]);
        state.answeredCurrent = true;
        const opt = state.shuffledCurrentOptions.find((o) => o.id === optId);
        await recordAnswer(q.id, Boolean(opt && opt.is_correct));
        render();
      });
    });
  } else if (q.type === "multiple_choice") {
    mainEl.querySelectorAll("[data-opt-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.answeredCurrent) return;
        const optId = btn.dataset.optId;
        if (state.selectedOptionIds.has(optId)) state.selectedOptionIds.delete(optId);
        else state.selectedOptionIds.add(optId);
        render();
      });
    });
    const checkBtn = document.getElementById("btn-check-multi");
    if (checkBtn) {
      checkBtn.addEventListener("click", async () => {
        if (state.selectedOptionIds.size === 0) {
          showToast("Выберите хотя бы один вариант");
          return;
        }
        state.answeredCurrent = true;
        const correctIds = new Set(
          state.shuffledCurrentOptions.filter((o) => o.is_correct).map((o) => o.id)
        );
        const isExact =
          correctIds.size === state.selectedOptionIds.size &&
          [...correctIds].every((id) => state.selectedOptionIds.has(id));
        await recordAnswer(q.id, isExact);
        render();
      });
    }
  }

  document.getElementById("btn-prev-q").addEventListener("click", () => {
    if (state.sessionIndex > 0) {
      state.sessionIndex--;
      prepareQuestionState();
      render();
    }
  });
  document.getElementById("btn-next-q").addEventListener("click", goNextQuestion);
}

function goNextQuestion() {
  if (state.sessionIndex + 1 < state.sessionQuestions.length) {
    state.sessionIndex++;
    prepareQuestionState();
    render();
  } else {
    state.view = "summary";
    render();
  }
}

function renderSummaryView() {
  titleEl.textContent = "Итоги тренировки";
  btnBack.classList.remove("hidden");
  const total = state.sessionCorrect + state.sessionWrong;
  const pct = total ? Math.round((state.sessionCorrect / total) * 100) : 0;

  mainEl.innerHTML = `
    <div class="card" style="text-align:center;">
      <h2 style="margin-top:0;">Сессия завершена!</h2>
      <div style="font-size:2.2rem;font-weight:700;margin:10px 0;">${pct}%</div>
      <div class="pills" style="justify-content:center;margin-bottom:16px;">
        <span class="pill ok">Верно: ${state.sessionCorrect}</span>
        <span class="pill err">Ошибок: ${state.sessionWrong}</span>
        <span class="pill">Всего в сессии: ${state.sessionQuestions.length}</span>
      </div>
      <button id="btn-back-cats" class="btn btn-primary">К списку тем</button>
    </div>
  `;
  document.getElementById("btn-back-cats").addEventListener("click", () => {
    state.view = "categories";
    render();
  });
}

function render() {
  if (state.view === "packages") renderPackagesView();
  else if (state.view === "categories") renderCategoriesView();
  else if (state.view === "trainer") renderTrainerView();
  else if (state.view === "summary") renderSummaryView();
}

// Navigation & global controls
btnBack.addEventListener("click", () => {
  revokeObjectUrls();
  if (state.view === "trainer" || state.view === "summary") {
    state.view = "categories";
  } else if (state.view === "categories") {
    state.view = "packages";
    state.activePackage = null;
  }
  render();
});

inputQpack.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await importQpackFile(file);
  inputQpack.value = "";
});

// Theme toggle
const savedTheme = localStorage.getItem("qpack_theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
btnTheme.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("qpack_theme", next);
});

// Backup modal
btnBackup.addEventListener("click", () => {
  backupStatus.textContent = "";
  modalBackup.classList.remove("hidden");
});
btnCloseBackup.addEventListener("click", () => modalBackup.classList.add("hidden"));
modalBackup.querySelector(".modal-backdrop").addEventListener("click", () => modalBackup.classList.add("hidden"));
lightbox.addEventListener("click", () => lightbox.classList.add("hidden"));

btnExportProgress.addEventListener("click", async () => {
  const data = await exportProgressBackup();
  const jsonText = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonText], { type: "application/json" });
  const file = new File([blob], "my_progress_backup.json", { type: "application/json" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Резервная копия QPack" });
      backupStatus.textContent = `Экспортировано записей: ${data.records.length}`;
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "my_progress_backup.json";
  a.click();
  URL.revokeObjectURL(url);
  backupStatus.textContent = `Экспортировано записей: ${data.records.length}`;
});

btnCopyProgress.addEventListener("click", async () => {
  const data = await exportProgressBackup();
  const jsonText = JSON.stringify(data, null, 2);
  try {
    await navigator.clipboard.writeText(jsonText);
    backupStatus.textContent = `Скопировано в буфер (${data.records.length} записей)`;
  } catch (err) {
    backupStatus.textContent = `Не удалось скопировать: ${err.message}`;
  }
});

btnImportProgress.addEventListener("click", () => inputBackup.click());
inputBackup.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const count = await importProgressBackup(JSON.parse(text));
    await refreshData();
    backupStatus.textContent = `Восстановлено записей: ${count}`;
  } catch (err) {
    backupStatus.textContent = `Ошибка: ${err.message}`;
  }
  inputBackup.value = "";
});

// PWA File Handling API ("Открыть в...")
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || !launchParams.files.length) return;
    for (const handle of launchParams.files) {
      const file = await handle.getFile();
      await importQpackFile(file);
    }
  });
}

// Register Service Worker (only in browser/PWA, not inside native Capacitor WebView)
const isNativeCapacitor = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if ("serviceWorker" in navigator && !isNativeCapacitor) {
  navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("SW error:", err));
}

// Init
refreshData();
