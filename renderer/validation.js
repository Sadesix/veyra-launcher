(() => {
  'use strict';
  let sequence = 0;
  const controls = root => [...root.querySelectorAll('input,select,textarea')].filter(input => !input.disabled && input.type !== 'hidden' && !input.closest('[hidden]'));
  function clear(input) {
    const id = input.dataset.errorId;
    if (id) document.getElementById(id)?.remove();
    input.removeAttribute('aria-invalid');
    if (id) input.setAttribute('aria-describedby', (input.getAttribute('aria-describedby') || '').split(' ').filter(value => value && value !== id).join(' '));
    delete input.dataset.errorId;
  }
  function message(input) {
    const value = input.value.trim(), validity = input.validity;
    if (input.required && !value) return 'Заполните это поле, чтобы продолжить.';
    if (validity.badInput) return 'Введите число.';
    if (!value) return '';
    if (validity.customError) return input.validationMessage;
    if (input.minLength > 0 && input.value.length < input.minLength) return 'Нужно минимум ' + input.minLength + ' символа.';
    if (input.maxLength > 0 && input.value.length > input.maxLength) return 'Можно не больше ' + input.maxLength + ' символов.';
    if (validity.patternMismatch) return input.id.includes('name') ? 'Используйте латинские буквы, цифры и _. Или разрешите любые символы.' : 'Проверьте формат значения.';
    if (validity.typeMismatch) return 'Проверьте формат значения.';
    if (validity.rangeUnderflow) return 'Минимальное значение — ' + input.min + '.';
    if (validity.rangeOverflow) return 'Максимальное значение — ' + input.max + '.';
    if (validity.stepMismatch) return 'Введите целое число.';
    return '';
  }
  function show(input, text) {
    clear(input);
    const feedback = document.createElement('small'); feedback.className = 'field-error'; feedback.id = 'field-error-' + ++sequence; feedback.role = 'alert'; feedback.textContent = text;
    const field = input.closest('.form-field,.memory-number,.settings-card') || input.parentElement;
    field.append(feedback); input.dataset.errorId = feedback.id; input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), feedback.id].filter(Boolean).join(' '));
  }
  function validate(root) {
    let first;
    for (const input of controls(root)) { const text = message(input); clear(input); if (text) { show(input, text); first ||= input; } }
    if (first) { first.focus(); first.scrollIntoView({ block: 'nearest' }); }
    return !first;
  }
  function alert(root, text) {
    let feedback = root.querySelector('.form-alert');
    if (!feedback) { feedback = document.createElement('p'); feedback.className = 'form-alert'; feedback.role = 'alert'; const header = root.querySelector('.modal-head,.studio-head'); if (header) header.after(feedback); else root.prepend(feedback); }
    feedback.textContent = text; feedback.hidden = !text;
  }
  for (const form of document.forms) form.noValidate = true;
  for (const use of document.querySelectorAll('use[href="#i-close"]')) use.closest('button')?.classList.add('close-control');
  for (const id of ['memory-gb', 'edit-memory']) document.getElementById(id).required = true;
  document.addEventListener('submit', event => { if (!validate(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  document.addEventListener('input', event => { if (event.target.matches('input,select,textarea')) clear(event.target); event.target.closest('form')?.querySelector('.form-alert')?.setAttribute('hidden', ''); });
  document.addEventListener('reset', event => { for (const input of controls(event.target)) clear(input); event.target.querySelector('.form-alert')?.setAttribute('hidden', ''); });
  document.addEventListener('invalid', event => { event.preventDefault(); show(event.target, message(event.target) || 'Проверьте значение.'); }, true);
  window.veyraValidation = Object.freeze({ validate, alert, clear });
})();
