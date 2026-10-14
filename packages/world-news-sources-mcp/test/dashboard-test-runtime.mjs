import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const dashboardApp = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
export function dashboardSection(start, end) {
  const first = dashboardApp.indexOf(start), last = dashboardApp.indexOf(end, first + start.length);
  if (first < 0 || last <= first) throw new Error('Missing shipped dashboard section');
  return dashboardApp.slice(first, last);
}
export const i18nHelpers = dashboardSection('// BEGIN I18N HELPERS', '// END I18N HELPERS');
export const i18nBindings = dashboardSection('// BEGIN I18N BINDINGS', '// END I18N BINDINGS');

// Existing helper tests exercise the selected Korean UI without duplicating its translations.
export function koreanUiContext(values = {}) {
  const context = vm.createContext({
    ...values,
    setText: (element, getter) => { element.textContent = String(getter()); },
    setLocalizedAttribute: (element, name, getter) => { element[name] = String(getter()); },
  });
  vm.runInContext(i18nHelpers + '\nsetLanguageValue("ko");', context);
  return context;
}
