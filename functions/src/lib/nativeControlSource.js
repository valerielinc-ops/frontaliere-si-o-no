/** Self-contained DOM source reader; serialized verbatim into the browser helper. */
/* global document, getComputedStyle */
export function readNativeControlInPage({ id, kind, widget, nativeSelectId, originalLabel, formPurposePattern }) {
      const byId = id => [...document.querySelectorAll('[id]')].filter(node => node.id === id);
      const nodes = [...document.querySelectorAll('[data-aa-id]')].filter(node => node.getAttribute('data-aa-id') === id);
      if (nodes.length !== 1) return null;
      const proxy = nodes[0];
      let control = proxy;
      if (widget === 'jquery-selectmenu' || widget === 'jquery-multiselect') {
        const native = byId(nativeSelectId);
        if (native.length !== 1 || native[0].tagName !== 'SELECT' || native[0].disabled) return null;
        control = native[0];
        if (control.form !== proxy.closest('form')
          || control.closest('fieldset,[role="group"],[role="radiogroup"]') !== proxy.closest('fieldset,[role="group"],[role="radiogroup"]')) return null;
        if (widget === 'jquery-selectmenu') {
          if (!proxy.classList.contains('ui-selectmenu-button') || proxy.id !== `${nativeSelectId}-button`
            || byId(proxy.id).length !== 1 || proxy.getAttribute('aria-owns') !== `${nativeSelectId}-menu`
            || control.multiple) return null;
        } else {
          const refs = String(control.getAttribute('aria-labelledby') || '').trim();
          if (!proxy.classList.contains('ui-multiselect') || proxy.previousElementSibling !== control
            || !refs || refs !== String(proxy.getAttribute('aria-labelledby') || '').trim()
            || refs.split(/\s+/).some(id => byId(id).length !== 1)) return null;
        }
      }
      if (control.id && byId(control.id).length !== 1) return null;
      const belongsToControl = node => node === control || node === proxy || control.contains(node) || proxy.contains(node)
        || node.matches('input[type="radio"]') && control.matches('input[type="radio"]') && node.name && node.name === control.name && node.form === control.form
        || node.matches('[role="checkbox"],[role="radio"],[role="combobox"]') && node.contains(control) && node.querySelectorAll('input,select,textarea').length === 1;
      const referenceOwned = node => {
        for (const label of [node, ...node.querySelectorAll('label')].filter(element => element.tagName === 'LABEL')) {
          if (label.htmlFor) {
            const target = byId(label.htmlFor);
            if (target.length !== 1 || !belongsToControl(target[0])) return false;
          } else if (label.control && !belongsToControl(label.control)) return false;
        }
        return ![node, ...node.querySelectorAll('input,select,textarea,[role="checkbox"],[role="radio"],[role="combobox"]')]
          .filter(element => element.matches('input,select,textarea,[role="checkbox"],[role="radio"],[role="combobox"]'))
          .some(element => !belongsToControl(element));
      };
      const counterFragments = [];
      const fullText = node => {
        if (String(node.textContent || '').includes('\uE000')) { unresolved = true; return ''; }
        const clone = node.cloneNode(true);
        const max = control.hasAttribute('maxlength') ? Number(control.getAttribute('maxlength')) : -1;
        // A standalone counter node is bound to the control's actual value
        // length AND native maximum. Arbitrary ratios in prose stay intact.
        const originalParts = [...node.querySelectorAll('output,span,[role="status"],[aria-live]')];
        const clonedParts = [...clone.querySelectorAll('output,span,[role="status"],[aria-live]')];
        for (let index = clonedParts.length - 1; index >= 0; index--) {
          const part = clonedParts[index], original = originalParts[index];
          if (part.children.length || original.closest('[hidden],[aria-hidden="true"]')) continue;
          let visible = true;
          for (let owner = original; owner; owner = owner.parentElement) {
            const style = getComputedStyle(owner);
            if (style.display === 'none' || style.visibility === 'hidden') { visible = false; break; }
          }
          if (!visible) continue;
          const token = `\uE000${counterFragments.length}\uE001`;
          counterFragments.push({ token, text: part.textContent, currentLength: String(control.value || '').length, maxLength: max });
          part.textContent = token;
        }
        for (const child of clone.querySelectorAll('input,select,textarea,button,script,style')) child.remove();
        for (const block of clone.querySelectorAll('p,div,section,legend,h1,h2,h3,h4,h5,h6,li,br')) { block.before(' '); block.after(' '); }
        return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
      };
      let unresolved = false;
      const referenceCache = new Map(), activeReferences = new Set(), referenceIds = new Set();
      const resolveReference = id => {
        referenceIds.add(id);
        const matches = byId(id);
        if (id.length > 256 || referenceIds.size > 24 || matches.length !== 1) { unresolved = true; return ''; }
        return referenceText(matches[0]);
      };
      const referenceText = node => {
        if (!referenceOwned(node) || activeReferences.has(node) || referenceCache.size >= 64) { unresolved = true; return ''; }
        if (referenceCache.has(node)) return referenceCache.get(node);
        activeReferences.add(node);
        const parts = [fullText(node)];
        for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-details']) {
          parts.push(...String(node.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean).map(resolveReference));
        }
        activeReferences.delete(node);
        const text = [...new Set(parts.filter(Boolean))].join(' · ');
        if (text.length > 8000) unresolved = true;
        referenceCache.set(node, text);
        return text;
      };
      const referenced = (attribute, element = control) => String(element.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean).map(resolveReference).filter(Boolean);
      const labels = [...(control.labels || [])].map(referenceText).filter(Boolean);
      const labelled = referenced('aria-labelledby');
      const descriptions = [...referenced('aria-describedby'), ...referenced('aria-details')];
      descriptions.push(control.getAttribute('aria-description') || '', control.getAttribute('aria-roledescription') || '');
      const aria = control.getAttribute('aria-label') || '';
      const title = control.getAttribute('title') || '';
      const placeholder = control.getAttribute('placeholder') || '';
      const accessible = control.matches('ui5-date-picker,[ui5-date-picker]') ? control.getAttribute('accessible-name') || '' : '';
      const ownLabels = labels.length ? labels : labelled.length ? labelled : aria ? [aria] : accessible ? [accessible] : [];
      let label = '';
      let section = '';
      if (kind !== 'radio' && ownLabels.length) label = ownLabels.join(' · ');
      if (!label && kind !== 'radio' && placeholder) label = placeholder;
      if (!label && kind !== 'radio' && control.name && control.name === originalLabel) label = control.name;
      if (kind === 'radio') {
        const group = control.closest('fieldset,[role="radiogroup"]');
        if (group) {
          const legends = [...group.children].filter(node => node.tagName === 'LEGEND');
          const groupRefs = String(group.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
          if (groupRefs.some(id => byId(id).length !== 1)) unresolved = true;
          const groupText = legends.length === 1 ? fullText(legends[0]) : groupRefs.map(id => byId(id).length === 1 ? fullText(byId(id)[0]) : '').join(' ')
            || group.getAttribute('aria-label') || '';
          if (groupText) label = groupText;
        }
      }
      const controlSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),select,textarea,[role="combobox"],[role="checkbox"],[role="radio"],button[aria-haspopup="listbox"],[role="button"][aria-haspopup="listbox"],ui5-date-picker,[ui5-date-picker],[data-scope="date-picker"][data-part="root"]';
      const nativeOwnedScopes = [], nativeScopeIssues = [], formQuestionContexts = [];
      const scopeIssues = new WeakMap();
      const headingNamesQuestion = (node, heading) => [...node.querySelectorAll(controlSelector)].some(question =>
        [...question.labels || []].some(label => label.contains(heading))
        || heading.id && byId(heading.id).length === 1
          && String(question.getAttribute('aria-labelledby') || '').split(/\s+/).includes(heading.id));
      const namedScope = (node, isForm) => {
        const names = [node.getAttribute('aria-label') || ''];
        const issues = [];
        const semanticHeadingUnknown = text => {
          names.push(text);
          issues.push({ reason: 'unrecognized_shared_heading', name: text });
        };
        let unknown = false;
        for (const ref of String(node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
          const matches = byId(ref);
          if (matches.length !== 1 || !referenceOwned(matches[0])) { unresolved = true; continue; }
          names.push(resolveReference(ref));
        }
        names.push(node.getAttribute('aria-description') || '', node.getAttribute('aria-roledescription') || '',
          ...referenced('aria-describedby', node), ...referenced('aria-details', node));
        const headings = [...node.children].filter(child => child.matches('legend,h1,h2,h3,h4,h5,h6,[role="heading"]'));
        const sameQuestion = [...node.querySelectorAll(controlSelector)].every(belongsToControl);
        for (const heading of headings) {
          if (!isForm && heading.tagName !== 'LEGEND' && !sameQuestion) {
            let purpose = false;
            if (typeof formPurposePattern === 'string' && formPurposePattern.length <= 8000) {
              try { purpose = new RegExp(formPurposePattern, 'iu').test(fullText(heading)); } catch { unknown = true; }
            }
            if (!purpose) {
              if (!referenceOwned(heading)) { unresolved = true; continue; }
              if (!headingNamesQuestion(node, heading)) semanticHeadingUnknown(fullText(heading));
              continue;
            }
          }
          if (!referenceOwned(heading)) { unresolved = true; continue; }
          const text = fullText(heading);
          // A form's first question heading is not a form-purpose label.
          if (isForm) {
            let purpose = false;
            if (typeof formPurposePattern === 'string' && formPurposePattern.length <= 8000) {
              try { purpose = new RegExp(formPurposePattern, 'iu').test(text); } catch { unknown = true; }
            }
            if (!purpose) {
              const questions = [...node.querySelectorAll(controlSelector)];
              const questionHeading = headingNamesQuestion(node, heading);
              const ownSingleHeading = questions.length > 0 && questions.every(belongsToControl);
              if (ownSingleHeading) {
                formQuestionContexts.push(text);
                if (!label) label = text;
              } else if (!questionHeading) semanticHeadingUnknown(text);
              continue;
            }
          }
          names.push(text);
        }
        const unique = [...new Set(names.map(name => name.trim()).filter(Boolean))];
        if (unique.length > 64 || unique.some(name => name.length > 8000) || unique.join(' · ').length > 12000) unresolved = true;
        unknown ||= issues.length > 0;
        const scope = { kind: isForm ? 'form' : 'group', names: unique, unknown };
        scopeIssues.set(scope, issues.map(issue => ({ reason: issue.reason, nameIndex: unique.indexOf(issue.name.trim()), refsComplete: true })));
        return scope;
      };
      const scopeSelector = 'fieldset,section,article,.field,.form-field,.form-group,.application-question,[role="group"],[role="radiogroup"],[role="region"],[aria-label],[aria-labelledby],[aria-description],[aria-roledescription],[aria-describedby],[aria-details],form,[role="form"]';
      const actualForm = 'form' in control ? control.form : control.closest('form');
      const roleForm = control.closest('[role="form"]');
      for (let owner = control.parentElement; owner; owner = owner.parentElement) {
        const ownHeadingGroup = [...owner.children].some(child => child.matches('h1,h2,h3,h4,h5,h6,[role="heading"]'));
        if (!owner.matches(scopeSelector) && !ownHeadingGroup) continue;
        const isForm = owner.matches('form,[role="form"]');
        if (isForm && owner !== actualForm && owner !== roleForm) continue;
        const scope = namedScope(owner, isForm);
        // Capture the full ancestor chain, but a caption outside the actual
        // form cannot establish whose answers its controls submit.
        const boundary = actualForm || roleForm;
        if (owner.matches('body,html') || boundary && owner !== boundary && !boundary.contains(owner)
          || !boundary && !owner.matches(scopeSelector)) {
          scope.unknown = true;
          scopeIssues.get(scope).push({ reason: 'outside_native_form', refsComplete: true });
        }
        nativeOwnedScopes.push(scope);
      }
      if (actualForm && !actualForm.contains(control)) nativeOwnedScopes.push(namedScope(actualForm, true));
      for (let scopeIndex = 0; scopeIndex < nativeOwnedScopes.length; scopeIndex++) {
        for (const issue of scopeIssues.get(nativeOwnedScopes[scopeIndex]) || []) nativeScopeIssues.push({ scopeIndex, ...issue });
      }
      if (nativeOwnedScopes.length > 32 || nativeScopeIssues.length > 64
        || nativeOwnedScopes.reduce((sum, scope) => sum + scope.names.reduce((total, name) => total + name.length, 0), 0) > 12000) unresolved = true;
      const nearestNamed = nativeOwnedScopes.find(scope => scope.kind === 'group' && scope.names.length);
      if (nearestNamed) section = nearestNamed.names.join(' · ');
      const ownQuestionGroups = new Set();
      const groupContexts = [], groupLinks = [];
      let contextUnknown = nativeOwnedScopes.some(scope => scope.unknown);
      const targetControl = belongsToControl;
      const staticGroupText = group => {
        const described = new Set();
        for (const input of [group, ...group.querySelectorAll(controlSelector)]) {
          for (const attr of ['aria-describedby', 'aria-details']) for (const ref of String(input.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
            const matches = byId(ref); if (matches.length === 1) described.add(matches[0]);
          }
        }
        const walk = node => {
          if (node.nodeType === 3) return node.nodeValue || '';
          if (node.nodeType !== 1 || ownQuestionGroups.has(node) || described.has(node)) return '';
          const nestedControls = [...node.querySelectorAll(controlSelector)];
          const foreignOwner = node.matches(scopeSelector)
            || [...node.querySelectorAll('label')].some(label => label.control && node.contains(label.control));
          if (node !== group && foreignOwner && nestedControls.length && nestedControls.every(control => !targetControl(control))) return '';
          if (node.matches(controlSelector + ',button,script,style,legend,h1,h2,h3,h4,h5,h6')) return '';
          if (node.tagName === 'LABEL' && (node.control || node.contains(control))) return '';
          const text = [...node.childNodes].map(walk).join('');
          return /^(P|DIV|SECTION|LI|BR)$/.test(node.tagName) ? ` ${text} ` : text;
        };
        return [...group.childNodes].map(walk).join('').replace(/\s+/g, ' ').trim();
      };
      for (let group = proxy.parentElement; group && !group.matches('form,[role="form"],body'); group = group.parentElement) {
        if (!group.matches(`${scopeSelector},li,div`)) continue;
        const controls = [...group.querySelectorAll(controlSelector)];
        const own = controls.length > 0 && controls.every(targetControl);
        const text = staticGroupText(group);
        if (!own) {
          // Unassociated prose in a shared question group cannot silently
          // disappear or be attributed to one of its other questions.
          if (text) contextUnknown = true;
          break;
        }
        if (!label) {
          const headings = [...group.children].filter(node => /^(LEGEND|H[1-6])$/.test(node.tagName));
          if (headings.length === 1) label = fullText(headings[0]);
        }
        if (text) groupContexts.push(text);
        groupContexts.push(...[group.getAttribute('aria-description') || '', group.getAttribute('aria-roledescription') || '',
          ...referenced('aria-describedby', group), ...referenced('aria-details', group)].filter(Boolean));
        const scope = namedScope(group, false);
        if (scope.unknown) contextUnknown = true;
        groupContexts.push(...scope.names);
        for (const link of group.querySelectorAll('a[href]')) groupLinks.push(link.href);
        ownQuestionGroups.add(group);
      }
      for (const form of new Set([actualForm, roleForm].filter(Boolean))) {
        const controls = [...new Set([...(form.elements || []), ...form.querySelectorAll(controlSelector)])].filter(node => node.matches(controlSelector));
        const text = staticGroupText(form);
        if (!text) continue;
        if (controls.length && controls.every(targetControl)) {
          groupContexts.push(text);
          for (const link of form.querySelectorAll('a[href]')) groupLinks.push(link.href);
        } else contextUnknown = true;
      }
      const formContext = nativeOwnedScopes.filter(scope => scope.kind === 'form').flatMap(scope => scope.names);
      const ownContext = [...new Set([...labelled, aria, accessible, ...descriptions, title, placeholder, ...groupContexts, ...formContext, ...formQuestionContexts].filter(Boolean))];
      if (!label || unresolved || section.length > 8000 || label.length > 8000 || ownContext.some(text => text.length > 8000)
        || ownContext.join(' · ').length > 12000) return null;
      const values = {};
      for (const key of ['type', 'min', 'max', 'minlength', 'maxlength', 'pattern', 'step', 'required', 'aria-required', 'multiple']) {
        if (control.hasAttribute(key)) values[key] = control.getAttribute(key);
      }
      if (typeof control.multiple === 'boolean') values.multiple = control.multiple;
      if (control.matches('input[type="file"]') && control.hasAttribute('accept')) values.accept = control.getAttribute('accept');
      const refs = [...new Set([proxy.getAttribute('aria-controls'), proxy.getAttribute('aria-owns')]
        .filter(Boolean).flatMap(value => value.trim().split(/\s+/)))];
      const lists = refs.map(byId).filter(matches => matches.length === 1).map(matches => matches[0])
        .filter(node => node.getAttribute('role') === 'listbox');
      if (proxy.getAttribute('role') === 'listbox') lists.push(proxy);
      const owners = [...new Set(lists)];
      const options = control.tagName === 'SELECT' ? [...control.options].filter(option => !option.disabled && !option.matches(':disabled') && !option.closest('optgroup')?.disabled)
        .map(option => ({ label: String(option.label || option.textContent || '').replace(/\s+/g, ' ').trim(), value: option.value,
          ...(control.required && !control.multiple && control.size <= 1 && control.options[0] === option
            && option.parentElement === control && option.value === '' ? { placeholder: true } : {}) }))
        : owners.length === 1 ? [...owners[0].querySelectorAll('[role="option"]')]
          .filter(option => option.getAttribute('aria-disabled') !== 'true')
          .map(option => ({ label: String(option.getAttribute('aria-label') || option.textContent || '').replace(/\s+/g, ' ').trim(),
            value: option.getAttribute('data-value') ?? option.getAttribute('value') ?? option.textContent,
            aaId: option.getAttribute('data-aa-id') || '' })) : [];
      let uncheckedSubmission;
      let uncheckedSubmissionUnknown = false;
      if (control.matches('input[type="checkbox"]') && control.name && control.form) {
        const named = [...control.form.elements].filter(element => element.form === control.form && element.name === control.name);
        const sameName = named.filter(element => !element.disabled && !element.matches(':disabled'));
        const checkboxes = named.filter(element => element.matches('input[type="checkbox"]'));
        const hidden = sameName.filter(element => element.matches('input[type="hidden"]'));
        if (hidden.length) {
          if (hidden.length !== 1 || checkboxes.length !== 1 || checkboxes[0] !== control
            || sameName.some(element => element !== control && element !== hidden[0])) uncheckedSubmissionUnknown = true;
          else uncheckedSubmission = { name: control.name, value: hidden[0].value, encoding: 'hidden_checkbox_fallback' };
        }
      }
      const current = {};
      let nativeValueUnknown = false;
      const extraOptionMeaning = option => {
        const name = String(option.label || option.getAttribute('aria-label') || option.textContent || '').replace(/\s+/g, ' ').trim();
        return ['aria-description', 'aria-roledescription', 'title'].some(attribute => option.hasAttribute(attribute)
          && String(option.getAttribute(attribute) || '').replace(/\s+/g, ' ').trim() !== name)
          || ['aria-describedby', 'aria-details', 'aria-labelledby'].some(attribute => option.hasAttribute(attribute))
          || option.hasAttribute('aria-label') && option.getAttribute('aria-label').trim() !== name
          || option.tagName !== 'OPTION' && option.hasAttribute('aria-label') && option.textContent.trim()
            && option.getAttribute('aria-label').trim() !== option.textContent.replace(/\s+/g, ' ').trim();
      };
      if (control.tagName === 'SELECT' && [...control.options].some(extraOptionMeaning)) nativeValueUnknown = true;
      if (owners.some(owner => [...owner.querySelectorAll('[role="option"]')].some(extraOptionMeaning))) nativeValueUnknown = true;
      if (kind === 'radio' && !control.matches('input[type="radio"]')) {
        const radios = control.matches('[role="radio"]') ? [control] : [...control.querySelectorAll('[role="radio"]')];
        if (!radios.length || [...control.querySelectorAll(controlSelector)].some(node => !node.matches('[role="radio"]'))) nativeValueUnknown = true;
        for (const radio of radios) {
          const parts = [], walker = document.createTreeWalker(radio, 4);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const value = String(text.nodeValue || '').replace(/\s+/g, ' ').trim();
            if (value.length > 1) parts.push(value);
          }
          const accessibleName = radio.getAttribute('aria-label') || '';
          if (parts.length > 2 || parts.join(' — ').length > 300 || accessibleName.length > 300
            || ['aria-description', 'aria-roledescription', 'aria-describedby', 'aria-details', 'title'].some(attribute => radio.hasAttribute(attribute))
            || accessibleName && parts.length && accessibleName !== parts.join(' — ')) nativeValueUnknown = true;
          for (let owner = radio.parentElement; owner && owner !== control; owner = owner.parentElement) {
            if (owner.matches(scopeSelector)) nativeValueUnknown = true;
          }
        }
        if ([...control.querySelectorAll('legend,h1,h2,h3,h4,h5,h6,[role="heading"]')].some(heading => fullText(heading) !== originalLabel)) nativeValueUnknown = true;
      }
      if (kind === 'radio' && control.matches('input[type="radio"]') && control.name) {
        const radios = [...document.querySelectorAll('input[type="radio"]')].filter(node => node.name === control.name && node.form === control.form);
        if (radios.some(node => node.closest('fieldset,[role="radiogroup"]') !== control.closest('fieldset,[role="radiogroup"]') || extraOptionMeaning(node))) nativeValueUnknown = true;
      }
      if (control.matches('input:not([type="password"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]),textarea')) {
        const value = String(control.value ?? '');
        if (value.length > 8000) nativeValueUnknown = true;
        current.value = nativeValueUnknown ? '' : value;
      } else if (control.tagName === 'SELECT') {
        const selected = [...control.selectedOptions].filter(option => !option.matches(':disabled') && !option.closest('optgroup:disabled'))
          .map(option => String(option.label || option.textContent || '').replace(/\s+/g, ' ').trim());
        if (selected.join(', ').length > 8000) nativeValueUnknown = true;
        current.value = nativeValueUnknown ? '' : selected.join(', ');
        current.nativeSelectedValues = nativeValueUnknown ? [] : selected;
      }
      if (control.matches('input[type="checkbox"]')) current.checked = control.checked;
      return { label, section, readOnly: Boolean(control.readOnly), disabled: control.disabled || control.matches(':disabled'),
        ...current, ...(nativeValueUnknown ? { nativeValueUnknown: true, nativeContractUnavailable: true } : {}),
        nativeUncheckedSubmission: uncheckedSubmission || null, nativeUncheckedSubmissionUnknown: uncheckedSubmissionUnknown,
        counterFragments, nativeOwnedScopes, nativeScopeIssues, nativeContextUnknown: contextUnknown, ownedQuestionContext: [...groupContexts, ...formQuestionContexts], ownedQuestionContextLinks: [...new Set(groupLinks)],
        context: ownContext.join(' · '), validation: values, nativeMetadataComplete: true,
        ...(control.tagName === 'SELECT' || options.length ? { options } : {}) };
}
