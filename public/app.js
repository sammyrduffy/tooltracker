// ---------------------------------------------------------------------------
// app.js  —  Runs the fast sign-out / check-in flow on the tool page.
//
// The flow is a few full-screen "steps": pick your name → tap your PIN →
// (sign-out only) pick a site → confirm. Everything happens without reloading
// the page, so it stays quick even on a phone with gloves on.
// ---------------------------------------------------------------------------

(function () {
  const toolPage = document.querySelector('.tool-page');
  const toolName = (document.querySelector('.tool-head h1') || {}).textContent || 'this tool';

  // Fresh state each time a flow is opened.
  let state = {};
  function resetState() { state = { employeeId: '', employeeName: '', pin: '', siteId: '', siteName: '' }; }

  // --- Open a flow when its big button is tapped ----------------------------
  document.querySelectorAll('[data-open-flow]').forEach((btn) => {
    btn.addEventListener('click', () => openFlow(btn.getAttribute('data-open-flow')));
  });

  function openFlow(name) {
    const form = document.querySelector(`form.flow[data-flow="${name}"]`);
    if (!form) return;
    resetState();
    form.querySelector('[name="employee_id"]').value = '';
    form.querySelector('[name="pin"]').value = '';
    const siteInput = form.querySelector('[name="site_id"]');
    if (siteInput) siteInput.value = '';
    if (toolPage) toolPage.hidden = true;
    form.hidden = false;
    goToStep(form, 0);
    window.scrollTo(0, 0);
  }

  function closeFlow(form) {
    form.hidden = true;
    if (toolPage) toolPage.hidden = false;
    window.scrollTo(0, 0);
  }

  // --- Move between steps ---------------------------------------------------
  function steps(form) { return Array.from(form.querySelectorAll('.step')); }

  function goToStep(form, index) {
    const all = steps(form);
    all.forEach((s, i) => { s.hidden = i !== index; });
    form._stepIndex = index;
    const current = all[index];
    if (!current) return;
    const kind = current.getAttribute('data-step');
    if (kind === 'pin') resetPin(form);
    if (kind === 'confirm') fillSummary(form);
    // Re-trigger the slide-in animation each time this step is shown.
    current.classList.remove('step-in');
    void current.offsetWidth; // force reflow
    current.classList.add('step-in');
    // Move focus to the top of the step for screen readers.
    current.scrollIntoView({ block: 'start' });
  }

  function nextStep(form) { goToStep(form, (form._stepIndex || 0) + 1); }
  function prevStep(form) {
    const i = form._stepIndex || 0;
    if (i <= 0) closeFlow(form); else goToStep(form, i - 1);
  }

  // --- Wire up every flow on the page ---------------------------------------
  document.querySelectorAll('form.flow').forEach((form) => {
    // Cancel (✕) and Back (←) buttons.
    form.querySelectorAll('[data-flow-cancel]').forEach((b) =>
      b.addEventListener('click', () => closeFlow(form)));
    form.querySelectorAll('[data-flow-back]').forEach((b) =>
      b.addEventListener('click', () => prevStep(form)));

    // Pick your name.
    form.querySelectorAll('[data-pick-employee]').forEach((b) =>
      b.addEventListener('click', () => {
        state.employeeId = b.getAttribute('data-pick-employee');
        state.employeeName = b.getAttribute('data-name');
        form.querySelector('[name="employee_id"]').value = state.employeeId;
        nextStep(form);
      }));

    // Pick a site (sign-out only).
    form.querySelectorAll('[data-pick-site]').forEach((b) =>
      b.addEventListener('click', () => {
        state.siteId = b.getAttribute('data-pick-site');
        state.siteName = b.getAttribute('data-name');
        form.querySelector('[name="site_id"]').value = state.siteId;
        nextStep(form);
      }));

    // PIN keypad.
    form.querySelectorAll('[data-key]').forEach((b) =>
      b.addEventListener('click', () => handleKey(form, b.getAttribute('data-key'))));

    // Prevent a double-tap on Confirm from submitting twice.
    form.addEventListener('submit', () => {
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Working…'; }
    });
  });

  // --- PIN entry ------------------------------------------------------------
  function resetPin(form) {
    state.pin = '';
    form.querySelector('[name="pin"]').value = '';
    updateDots(form);
  }

  function handleKey(form, key) {
    if (key === 'back') {
      state.pin = state.pin.slice(0, -1);
    } else if (state.pin.length < 4) {
      state.pin += key;
    }
    form.querySelector('[name="pin"]').value = state.pin;
    updateDots(form);
    if (state.pin.length === 4) {
      // Brief pause so the 4th dot is visible before advancing.
      setTimeout(() => nextStep(form), 150);
    }
  }

  function updateDots(form) {
    const dots = form.querySelectorAll('.pin__dot');
    dots.forEach((d, i) => d.classList.toggle('filled', i < state.pin.length));
  }

  // --- Confirmation summary -------------------------------------------------
  function fillSummary(form) {
    const el = form.querySelector('[data-summary]');
    if (!el) return;
    if (form.getAttribute('data-flow') === 'signout') {
      el.textContent = `Sign out "${toolName}" to ${state.employeeName} for ${state.siteName}.`;
    } else {
      el.textContent = `Check in "${toolName}" as ${state.employeeName}.`;
    }
  }

  // --- Optional: let a physical keyboard type the PIN (handy on a laptop) ---
  document.addEventListener('keydown', (e) => {
    const form = Array.from(document.querySelectorAll('form.flow')).find((f) => !f.hidden);
    if (!form) return;
    const pinStep = steps(form)[form._stepIndex || 0];
    if (!pinStep || pinStep.getAttribute('data-step') !== 'pin') return;
    if (/^[0-9]$/.test(e.key)) handleKey(form, e.key);
    else if (e.key === 'Backspace') { e.preventDefault(); handleKey(form, 'back'); }
  });
})();
