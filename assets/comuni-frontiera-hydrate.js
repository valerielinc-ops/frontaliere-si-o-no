(function () {
  const panels = document.querySelectorAll('[data-border-municipality-hydrator]');
  if (!panels.length) return;

  const activeClasses = ['border-accent-border', 'bg-accent-subtle', 'text-accent'];
  const inactiveClasses = ['border-edge', 'bg-surface-raised', 'text-heading'];

  function parseData(panel) {
    const dataNode = panel.querySelector('[data-border-municipality-data]');
    if (!dataNode || !dataNode.textContent) return null;
    try {
      return JSON.parse(dataNode.textContent);
    } catch {
      return null;
    }
  }

  function money(value, data) {
    return `${data.currencyPrefix} ${new Intl.NumberFormat(data.locale || 'it', {
      maximumFractionDigits: 0,
    }).format(value)}`;
  }

  function setPressed(buttons, selectedValue, attrName) {
    buttons.forEach((button) => {
      const isActive = button.getAttribute(attrName) === selectedValue;
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      button.classList.toggle(activeClasses[0], isActive);
      button.classList.toggle(activeClasses[1], isActive);
      button.classList.toggle(activeClasses[2], isActive);
      button.classList.toggle(inactiveClasses[0], !isActive);
      button.classList.toggle(inactiveClasses[1], !isActive);
      button.classList.toggle(inactiveClasses[2], !isActive);
    });
  }

  function bestRoute(data, destination, peak) {
    return data.routes
      .map((route) => {
        const wait = route.waits[peak] || route.waits.now || route.waits.morning;
        const destinationData = route.destinations[destination];
        return {
          route,
          wait,
          destinationData,
          minutes: destinationData.baseMinutes + wait.minutes,
        };
      })
      .sort((a, b) => a.minutes - b.minutes)[0];
  }

  function fillTemplate(template, values) {
    return Object.entries(values).reduce(
      (text, entry) => text.replaceAll(`{${entry[0]}}`, String(entry[1])),
      template,
    );
  }

  function initPanel(panel) {
    const data = parseData(panel);
    if (!data || !Array.isArray(data.routes) || data.routes.length === 0) return;

    let destination = data.defaultDestination || 'lugano';
    let peak = data.defaultPeak || 'now';
    const destinationButtons = Array.from(panel.querySelectorAll('[data-comuni-destination]'));
    const peakButtons = Array.from(panel.querySelectorAll('[data-comuni-peak]'));
    const minutesNode = panel.querySelector('[data-comuni-output="minutes"]');
    const crossingNode = panel.querySelector('[data-comuni-output="crossing"]');
    const costNode = panel.querySelector('[data-comuni-output="cost"]');
    const summaryNode = panel.querySelector('[data-comuni-output="summary"]');
    const linkNode = panel.querySelector('[data-border-municipality-link]');

    function render() {
      const selected = bestRoute(data, destination, peak);
      if (!selected) return;
      const minutes = `${selected.minutes} ${data.labels.minutesSuffix}`;
      const waitLabel = selected.wait.label || `${selected.wait.minutes} ${data.labels.minutesSuffix}`;
      if (minutesNode) minutesNode.textContent = minutes;
      if (crossingNode) crossingNode.textContent = selected.route.name;
      if (costNode) costNode.textContent = `${money(selected.destinationData.costMonthly, data)}${data.labels.monthlySuffix}`;
      if (summaryNode) {
        summaryNode.textContent = fillTemplate(data.labels.summaryTemplate, {
          crossing: selected.route.name,
          destination: data.labels.destination[destination] || destination,
          minutes,
          wait: waitLabel,
        });
      }
      if (linkNode) linkNode.setAttribute('href', selected.route.href);
      setPressed(destinationButtons, destination, 'data-comuni-destination');
      setPressed(peakButtons, peak, 'data-comuni-peak');
    }

    destinationButtons.forEach((button) => {
      button.addEventListener('click', () => {
        destination = button.getAttribute('data-comuni-destination') || destination;
        render();
      });
    });

    peakButtons.forEach((button) => {
      button.addEventListener('click', () => {
        peak = button.getAttribute('data-comuni-peak') || peak;
        render();
      });
    });

    panel.setAttribute('data-hydrated', 'true');
    render();
  }

  panels.forEach(initPanel);
})();
