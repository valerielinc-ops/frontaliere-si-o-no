/**
 * Google Sheets Analytics Dashboard for Frontaliere Ticino
 * =========================================================
 *
 * HOW TO USE:
 * 1. Create a new Google Spreadsheet
 * 2. Go to Extensions → Apps Script
 * 3. Delete the default code, paste this entire file
 * 4. Set the CONFIG values below (GA4 Property ID, site URL)
 * 5. Click "Run" → select "setupDashboard" → Authorize when prompted
 * 6. The script creates all sheets, populates data, and generates charts
 *
 * TO AUTO-REFRESH:
 * - In Apps Script: Triggers (clock icon) → "+ Add Trigger"
 * - Function: refreshAllData
 * - Event source: Time-driven
 * - Timer: Week timer → Every Monday at 6am (or your preference)
 *
 * REQUIRED API SERVICES:
 * In Apps Script → Services (+ icon on left sidebar), enable:
 * - Google Analytics Data API (v1beta)
 * - Google Search Console API (Webmasters API)
 */

// ════════════════════════════════════════════
// CONFIGURATION — Edit these values
// ════════════════════════════════════════════

const CONFIG = {
  // Your GA4 Property ID (find in GA4 → Admin → Property Settings → Property ID)
  // Format: just the number, e.g., '123456789'
  GA4_PROPERTY_ID: 'YOUR_GA4_PROPERTY_ID',

  // Your website URL for Search Console (must be a verified property)
  SITE_URL: 'https://frontaliereticino.ch/',

  // Date range: how many days to look back
  DAYS_BACK: 30,

  // Sheet names (customize if you prefer different names)
  SHEETS: {
    OVERVIEW:       '📊 Overview',
    TRAFFIC:        '🚦 Traffic Sources',
    CONTENT:        '📄 Content & Pages',
    SEARCH:         '🔍 Search Console',
    FUNNEL:         '🔢 Calculator Funnel',
    ERRORS:         '⚠️ Errors & Health',
    SCROLL:         '📜 Scroll & Engagement',
    USERS:          '👥 Users',
  },
};

// ════════════════════════════════════════════
// SETUP — Run this once
// ════════════════════════════════════════════

function setupDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create all sheets
  for (const [key, name] of Object.entries(CONFIG.SHEETS)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
  }

  // Remove default "Sheet1" if it exists
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  // Populate all data
  refreshAllData();

  // Set the overview sheet as active
  const overviewSheet = ss.getSheetByName(CONFIG.SHEETS.OVERVIEW);
  if (overviewSheet) ss.setActiveSheet(overviewSheet);

  SpreadsheetApp.getUi().alert(
    '✅ Dashboard Created!',
    'All sheets have been populated with data.\n\n' +
    'To auto-refresh weekly:\n' +
    '1. Go to Triggers (clock icon in Apps Script)\n' +
    '2. Add Trigger → refreshAllData → Week timer → Monday 6am',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ════════════════════════════════════════════
// REFRESH — Run this on schedule
// ════════════════════════════════════════════

function refreshAllData() {
  const startDate = getDateNDaysAgo(CONFIG.DAYS_BACK);
  const endDate = getDateNDaysAgo(0);

  fetchOverview(startDate, endDate);
  fetchTrafficSources(startDate, endDate);
  fetchContentPages(startDate, endDate);
  fetchSearchConsole(startDate, endDate);
  fetchCalculatorFunnel(startDate, endDate);
  fetchErrorsHealth(startDate, endDate);
  fetchScrollDepth(startDate, endDate);
  fetchUsers(startDate, endDate);

  // Update "last refreshed" timestamp on overview
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEETS.OVERVIEW);
  if (sheet) {
    sheet.getRange('A1').setValue(`Last updated: ${new Date().toLocaleString()}`);
  }
}

// ════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function clearSheet(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    sheet.clear();
    // Remove all charts
    const charts = sheet.getCharts();
    for (const chart of charts) {
      sheet.removeChart(chart);
    }
  }
  return sheet;
}

function writeTable(sheet, startRow, startCol, headers, data) {
  // Write headers in bold
  const headerRange = sheet.getRange(startRow, startCol, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4285f4');
  headerRange.setFontColor('white');

  // Write data
  if (data.length > 0) {
    const dataRange = sheet.getRange(startRow + 1, startCol, data.length, headers.length);
    dataRange.setValues(data);

    // Alternate row colors
    for (let i = 0; i < data.length; i++) {
      if (i % 2 === 1) {
        sheet.getRange(startRow + 1 + i, startCol, 1, headers.length).setBackground('#f3f6fc');
      }
    }
  }

  // Auto-resize columns
  for (let c = startCol; c < startCol + headers.length; c++) {
    sheet.autoResizeColumn(c);
  }

  return startRow + 1 + data.length;
}

function runGA4Report(propertyId, dateRanges, dimensions, metrics, options = {}) {
  const request = {
    dateRanges: dateRanges,
    dimensions: dimensions.map(d => ({ name: d })),
    metrics: metrics.map(m => ({ name: m })),
  };

  if (options.dimensionFilter) {
    request.dimensionFilter = options.dimensionFilter;
  }
  if (options.orderBys) {
    request.orderBys = options.orderBys;
  }
  if (options.limit) {
    request.limit = options.limit;
  }

  const response = AnalyticsData.Properties.runReport(request, `properties/${propertyId}`);

  const rows = [];
  if (response.rows) {
    for (const row of response.rows) {
      const dims = (row.dimensionValues || []).map(d => d.value);
      const mets = (row.metricValues || []).map(m => {
        const num = parseFloat(m.value);
        return isNaN(num) ? m.value : num;
      });
      rows.push([...dims, ...mets]);
    }
  }
  return rows;
}

function addBarChart(sheet, title, dataRange, startRow, startCol, width, height) {
  const chartBuilder = sheet.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(dataRange)
    .setPosition(startRow, startCol, 0, 0)
    .setOption('title', title)
    .setOption('width', width || 600)
    .setOption('height', height || 350)
    .setOption('legend', { position: 'none' })
    .setOption('hAxis', { minValue: 0 });
  sheet.insertChart(chartBuilder.build());
}

function addLineChart(sheet, title, dataRange, startRow, startCol, width, height) {
  const chartBuilder = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(dataRange)
    .setPosition(startRow, startCol, 0, 0)
    .setOption('title', title)
    .setOption('width', width || 700)
    .setOption('height', height || 350)
    .setOption('curveType', 'function')
    .setOption('legend', { position: 'bottom' });
  sheet.insertChart(chartBuilder.build());
}

function addPieChart(sheet, title, dataRange, startRow, startCol) {
  const chartBuilder = sheet.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(dataRange)
    .setPosition(startRow, startCol, 0, 0)
    .setOption('title', title)
    .setOption('width', 450)
    .setOption('height', 350)
    .setOption('legend', { position: 'right' })
    .setOption('pieHole', 0.4);
  sheet.insertChart(chartBuilder.build());
}

// ════════════════════════════════════════════
// PAGE 1: OVERVIEW
// ════════════════════════════════════════════

function fetchOverview(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.OVERVIEW);
  if (!sheet) return;

  sheet.getRange('A1').setValue(`Last updated: ${new Date().toLocaleString()}`).setFontSize(10).setFontColor('#666');
  sheet.getRange('A2').setValue('📊 Analytics Dashboard — Frontaliere Ticino').setFontSize(16).setFontWeight('bold');
  sheet.getRange('A3').setValue(`Period: ${startDate} → ${endDate}`).setFontSize(10).setFontColor('#666');

  // KPI scorecards
  const kpiData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    [],
    ['totalUsers', 'sessions', 'bounceRate', 'averageSessionDuration', 'engagedSessions', 'screenPageViews', 'engagementRate', 'newUsers']
  );

  if (kpiData.length > 0) {
    const [users, sessions, bounceRate, avgDuration, engaged, pageViews, engRate, newUsers] = kpiData[0];
    const kpis = [
      ['Metric', 'Value'],
      ['👥 Total Users', users],
      ['🆕 New Users', newUsers],
      ['📊 Sessions', sessions],
      ['📄 Page Views', pageViews],
      ['📈 Engagement Rate', `${(engRate * 100).toFixed(1)}%`],
      ['🔄 Bounce Rate', `${(bounceRate * 100).toFixed(1)}%`],
      ['⏱️ Avg Duration', `${Math.round(avgDuration)}s`],
      ['✅ Engaged Sessions', engaged],
    ];
    sheet.getRange(5, 1, kpis.length, 2).setValues(kpis);
    sheet.getRange(5, 1, 1, 2).setFontWeight('bold').setBackground('#4285f4').setFontColor('white');
    sheet.autoResizeColumn(1);
    sheet.autoResizeColumn(2);
    sheet.setColumnWidth(2, 150);
  }

  // Daily trend
  const dailyData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['date'],
    ['totalUsers', 'sessions'],
    { orderBys: [{ dimension: { dimensionName: 'date' } }] }
  );

  if (dailyData.length > 0) {
    const trendStart = 16;
    const headers = ['Date', 'Users', 'Sessions'];
    const formattedData = dailyData.map(row => {
      const d = String(row[0]);
      return [`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`, row[1], row[2]];
    });
    writeTable(sheet, trendStart, 1, headers, formattedData);

    const dataRange = sheet.getRange(trendStart, 1, formattedData.length + 1, 3);
    addLineChart(sheet, 'Daily Users & Sessions', dataRange, trendStart, 5, 700, 350);
  }

  // New vs Returning
  const nvrData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['newVsReturning'],
    ['totalUsers', 'sessions', 'engagementRate']
  );

  if (nvrData.length > 0) {
    const nvrStart = 16 + dailyData.length + 3;
    const headers = ['Type', 'Users', 'Sessions', 'Engagement Rate'];
    const formatted = nvrData.map(row => [row[0], row[1], row[2], `${(row[3] * 100).toFixed(1)}%`]);
    writeTable(sheet, nvrStart, 1, headers, formatted);

    const pieRange = sheet.getRange(nvrStart, 1, formatted.length + 1, 2);
    addPieChart(sheet, 'New vs Returning Users', pieRange, nvrStart, 5);
  }
}

// ════════════════════════════════════════════
// PAGE 2: TRAFFIC SOURCES
// ════════════════════════════════════════════

function fetchTrafficSources(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.TRAFFIC);
  if (!sheet) return;

  sheet.getRange('A1').setValue('🚦 Traffic Sources').setFontSize(14).setFontWeight('bold');

  // Channel groups
  const channelData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['sessionDefaultChannelGroup'],
    ['sessions', 'totalUsers', 'engagementRate', 'bounceRate'],
    { orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 15 }
  );

  let nextRow = 3;
  if (channelData.length > 0) {
    const headers = ['Channel', 'Sessions', 'Users', 'Engagement Rate', 'Bounce Rate'];
    const formatted = channelData.map(r => [r[0], r[1], r[2], `${(r[3]*100).toFixed(1)}%`, `${(r[4]*100).toFixed(1)}%`]);
    nextRow = writeTable(sheet, nextRow, 1, headers, formatted);

    const pieRange = sheet.getRange(3, 1, formatted.length + 1, 2);
    addPieChart(sheet, 'Sessions by Channel', pieRange, 3, 7);
    nextRow += 2;
  }

  // Source/Medium detail
  const smData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['sessionSourceMedium'],
    ['sessions', 'totalUsers', 'engagementRate', 'bounceRate'],
    { orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 20 }
  );

  if (smData.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Source / Medium Detail').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    const headers = ['Source / Medium', 'Sessions', 'Users', 'Engagement Rate', 'Bounce Rate'];
    const formatted = smData.map(r => [r[0], r[1], r[2], `${(r[3]*100).toFixed(1)}%`, `${(r[4]*100).toFixed(1)}%`]);
    writeTable(sheet, nextRow, 1, headers, formatted);
  }
}

// ════════════════════════════════════════════
// PAGE 3: CONTENT & PAGES
// ════════════════════════════════════════════

function fetchContentPages(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.CONTENT);
  if (!sheet) return;

  sheet.getRange('A1').setValue('📄 Content & Pages').setFontSize(14).setFontWeight('bold');

  // Top pages
  const pageData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['pagePath'],
    ['screenPageViews', 'totalUsers', 'averageSessionDuration', 'bounceRate'],
    { orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 25 }
  );

  let nextRow = 3;
  if (pageData.length > 0) {
    const headers = ['Page', 'Views', 'Users', 'Avg Duration (s)', 'Bounce Rate'];
    const formatted = pageData.map(r => [r[0], r[1], r[2], Math.round(r[3]), `${(r[4]*100).toFixed(1)}%`]);
    nextRow = writeTable(sheet, nextRow, 1, headers, formatted);
    nextRow += 2;
  }

  // Landing pages
  const landingData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['landingPagePlusQueryString'],
    ['sessions', 'bounceRate', 'engagementRate'],
    { orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 20 }
  );

  if (landingData.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Top Landing Pages').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    const headers = ['Landing Page', 'Sessions', 'Bounce Rate', 'Engagement Rate'];
    const formatted = landingData.map(r => [r[0], r[1], `${(r[2]*100).toFixed(1)}%`, `${(r[3]*100).toFixed(1)}%`]);
    nextRow = writeTable(sheet, nextRow, 1, headers, formatted);
    nextRow += 2;
  }

  // High-bounce pages (>50% bounce, ≥10 sessions)
  const bounceData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['pagePath'],
    ['sessions', 'bounceRate'],
    { orderBys: [{ metric: { metricName: 'bounceRate' }, desc: true }], limit: 50 }
  );

  const highBounce = bounceData.filter(r => r[1] >= 10 && r[2] > 0.5);
  if (highBounce.length > 0) {
    sheet.getRange(nextRow, 1).setValue('⚠️ High-Bounce Pages (>50%, ≥10 sessions)').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    const headers = ['Page', 'Sessions', 'Bounce Rate'];
    const formatted = highBounce.slice(0, 15).map(r => [r[0], r[1], `${(r[2]*100).toFixed(1)}%`]);
    writeTable(sheet, nextRow, 1, headers, formatted);
  }
}

// ════════════════════════════════════════════
// PAGE 4: SEARCH CONSOLE
// ════════════════════════════════════════════

function fetchSearchConsole(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.SEARCH);
  if (!sheet) return;

  sheet.getRange('A1').setValue('🔍 Search Console').setFontSize(14).setFontWeight('bold');

  try {
    // Top queries
    const queryResponse = SearchConsole.Searchanalytics.query({
      startDate: startDate,
      endDate: endDate,
      dimensions: ['query'],
      rowLimit: 25,
    }, CONFIG.SITE_URL);

    let nextRow = 3;
    if (queryResponse.rows && queryResponse.rows.length > 0) {
      const headers = ['Query', 'Clicks', 'Impressions', 'CTR', 'Position'];
      const data = queryResponse.rows.map(r => [
        r.keys[0],
        r.clicks,
        r.impressions,
        `${(r.ctr * 100).toFixed(1)}%`,
        r.position.toFixed(1),
      ]);
      nextRow = writeTable(sheet, nextRow, 1, headers, data);

      const barRange = sheet.getRange(3, 1, Math.min(data.length, 15) + 1, 2);
      addBarChart(sheet, 'Top Queries by Clicks', barRange, 3, 7, 500, 400);
      nextRow += 2;
    }

    // Top pages
    const pageResponse = SearchConsole.Searchanalytics.query({
      startDate: startDate,
      endDate: endDate,
      dimensions: ['page'],
      rowLimit: 20,
    }, CONFIG.SITE_URL);

    if (pageResponse.rows && pageResponse.rows.length > 0) {
      sheet.getRange(nextRow, 1).setValue('Top Pages from Search').setFontSize(12).setFontWeight('bold');
      nextRow += 1;
      const headers = ['Page URL', 'Clicks', 'Impressions', 'CTR', 'Position'];
      const data = pageResponse.rows.map(r => [
        r.keys[0].replace(CONFIG.SITE_URL, '/'),
        r.clicks,
        r.impressions,
        `${(r.ctr * 100).toFixed(1)}%`,
        r.position.toFixed(1),
      ]);
      nextRow = writeTable(sheet, nextRow, 1, headers, data);
      nextRow += 2;
    }

    // Daily trend
    const dailyResponse = SearchConsole.Searchanalytics.query({
      startDate: startDate,
      endDate: endDate,
      dimensions: ['date'],
    }, CONFIG.SITE_URL);

    if (dailyResponse.rows && dailyResponse.rows.length > 0) {
      sheet.getRange(nextRow, 1).setValue('Daily Search Trend').setFontSize(12).setFontWeight('bold');
      nextRow += 1;
      const headers = ['Date', 'Clicks', 'Impressions'];
      const data = dailyResponse.rows.map(r => [r.keys[0], r.clicks, r.impressions]);
      const trendTableEnd = writeTable(sheet, nextRow, 1, headers, data);

      const lineRange = sheet.getRange(nextRow, 1, data.length + 1, 3);
      addLineChart(sheet, 'Search Clicks & Impressions', lineRange, nextRow, 5, 700, 350);
    }

  } catch (e) {
    sheet.getRange('A3').setValue(`⚠️ Search Console error: ${e.message}`).setFontColor('red');
    sheet.getRange('A4').setValue('Make sure Search Console API is enabled in Apps Script Services');
  }
}

// ════════════════════════════════════════════
// PAGE 5: CALCULATOR FUNNEL
// ════════════════════════════════════════════

function fetchCalculatorFunnel(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.FUNNEL);
  if (!sheet) return;

  sheet.getRange('A1').setValue('🔢 Calculator Funnel').setFontSize(14).setFontWeight('bold');

  // Funnel steps (requires step_name custom dimension to be registered in GA4)
  const funnelData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['customEvent:step_name'],
    ['eventCount', 'totalUsers'],
    {
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { value: 'funnel_step', matchType: 'EXACT' },
        },
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    }
  );

  let nextRow = 3;
  if (funnelData.length > 0) {
    // Order funnel steps logically
    const stepOrder = ['entry', 'input_start', 'calculate', 'compare', 'cta_click'];
    const ordered = stepOrder
      .map(s => funnelData.find(r => r[0] === s) || [s, 0, 0])
      .filter(r => r[1] > 0 || stepOrder.indexOf(r[0]) <= 2);

    const headers = ['Step', 'Events', 'Users', 'Drop-off'];
    const formatted = ordered.map((r, i) => {
      const prevUsers = i > 0 ? ordered[i-1][2] : r[2];
      const dropOff = i > 0 && prevUsers > 0 ? `${((1 - r[2] / prevUsers) * 100).toFixed(0)}%` : '';
      return [r[0], r[1], r[2], dropOff];
    });
    nextRow = writeTable(sheet, nextRow, 1, headers, formatted);

    // Overall conversion
    if (ordered.length >= 2) {
      const first = ordered[0][2];
      const last = ordered[ordered.length - 1][2];
      const conv = first > 0 ? ((last / first) * 100).toFixed(1) : '0';
      nextRow += 1;
      sheet.getRange(nextRow, 1).setValue(`Overall conversion: ${conv}% (${ordered[0][0]} → ${ordered[ordered.length-1][0]})`).setFontWeight('bold');
      nextRow += 2;
    }

    const barRange = sheet.getRange(3, 1, formatted.length + 1, 3);
    addBarChart(sheet, 'Funnel Steps', barRange, 3, 6, 500, 300);
  } else {
    sheet.getRange('A3').setValue('No funnel data yet. Register "step_name" as a custom dimension in GA4 Admin.');
    sheet.getRange('A4').setValue('Go to: GA4 → Admin → Custom definitions → Create → Event scope → Parameter: step_name');
  }

  // Custom events overview
  const eventsData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['eventName'],
    ['eventCount', 'totalUsers'],
    { orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 30 }
  );

  // Filter out built-in events
  const builtIn = ['page_view', 'session_start', 'first_visit', 'user_engagement', 'scroll'];
  const customEvents = eventsData.filter(r => !builtIn.includes(r[0]));

  if (customEvents.length > 0) {
    nextRow += 2;
    sheet.getRange(nextRow, 1).setValue('Custom Events').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    const headers = ['Event', 'Count', 'Users'];
    writeTable(sheet, nextRow, 1, headers, customEvents);
  }
}

// ════════════════════════════════════════════
// PAGE 6: ERRORS & HEALTH
// ════════════════════════════════════════════

function fetchErrorsHealth(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.ERRORS);
  if (!sheet) return;

  sheet.getRange('A1').setValue('⚠️ Errors & Health').setFontSize(14).setFontWeight('bold');

  let nextRow = 3;

  // Error events count
  const errorEvents = ['app_error', 'force_reload', 'resource_load_error', 'css_fallback', 'chunk_retry'];
  const errorData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['eventName'],
    ['eventCount', 'totalUsers'],
    {
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: errorEvents },
        },
      },
    }
  );

  if (errorData.length > 0) {
    const headers = ['Event', 'Count', 'Affected Users'];
    nextRow = writeTable(sheet, nextRow, 1, headers, errorData);

    const barRange = sheet.getRange(3, 1, errorData.length + 1, 2);
    addBarChart(sheet, 'Error Events', barRange, 3, 5, 450, 300);
    nextRow += 2;
  } else {
    sheet.getRange(nextRow, 1).setValue('✅ No error events in this period').setFontColor('green');
    nextRow += 2;
  }

  // Error trend (daily)
  const errorTrend = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['date', 'eventName'],
    ['eventCount'],
    {
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: errorEvents },
        },
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }
  );

  if (errorTrend.length > 0) {
    // Pivot: date → event columns
    const dates = [...new Set(errorTrend.map(r => r[0]))].sort();
    const pivoted = dates.map(date => {
      const row = { date: `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}` };
      for (const evt of errorEvents) {
        const match = errorTrend.find(r => r[0] === date && r[1] === evt);
        row[evt] = match ? match[2] : 0;
      }
      return row;
    });

    sheet.getRange(nextRow, 1).setValue('Error Trend (Daily)').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    const headers = ['Date', ...errorEvents];
    const data = pivoted.map(r => [r.date, ...errorEvents.map(e => r[e])]);
    const trendEnd = writeTable(sheet, nextRow, 1, headers, data);

    if (data.length > 1) {
      const lineRange = sheet.getRange(nextRow, 1, data.length + 1, headers.length);
      addLineChart(sheet, 'Error Events Over Time', lineRange, nextRow, headers.length + 2, 700, 350);
    }
    nextRow = trendEnd + 2;
  }

  // Error types (requires custom dimension)
  const errorTypes = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['customEvent:error_type'],
    ['eventCount'],
    {
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { value: 'app_error', matchType: 'EXACT' },
        },
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 15,
    }
  );

  if (errorTypes.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Error Types Breakdown').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    writeTable(sheet, nextRow, 1, ['Error Type', 'Count'], errorTypes);
  }
}

// ════════════════════════════════════════════
// PAGE 7: SCROLL & ENGAGEMENT
// ════════════════════════════════════════════

function fetchScrollDepth(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.SCROLL);
  if (!sheet) return;

  sheet.getRange('A1').setValue('📜 Scroll & Engagement').setFontSize(14).setFontWeight('bold');

  let nextRow = 3;

  // Scroll depth (requires percent_scrolled custom dimension)
  const scrollData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['customEvent:percent_scrolled'],
    ['eventCount'],
    {
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { value: 'scroll_depth', matchType: 'EXACT' },
        },
      },
      orderBys: [{ dimension: { dimensionName: 'customEvent:percent_scrolled' } }],
    }
  );

  if (scrollData.length > 0) {
    const headers = ['Scroll Depth', 'Events'];
    const formatted = scrollData.map(r => [`${r[0]}%`, r[1]]);
    nextRow = writeTable(sheet, nextRow, 1, headers, formatted);

    const barRange = sheet.getRange(3, 1, formatted.length + 1, 2);
    addBarChart(sheet, 'Scroll Depth Distribution', barRange, 3, 4, 450, 300);
    nextRow += 2;
  } else {
    sheet.getRange(nextRow, 1).setValue('No scroll_depth data yet. Register "percent_scrolled" as a custom dimension in GA4.');
    nextRow += 2;
  }

  // Scroll by page
  const scrollByPage = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['pagePath', 'customEvent:percent_scrolled'],
    ['eventCount'],
    {
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          stringFilter: { value: 'scroll_depth', matchType: 'EXACT' },
        },
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 50,
    }
  );

  if (scrollByPage.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Scroll Depth by Page').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    writeTable(sheet, nextRow, 1, ['Page', 'Scroll %', 'Events'], scrollByPage);
  }
}

// ════════════════════════════════════════════
// PAGE 8: USERS
// ════════════════════════════════════════════

function fetchUsers(startDate, endDate) {
  const sheet = clearSheet(CONFIG.SHEETS.USERS);
  if (!sheet) return;

  sheet.getRange('A1').setValue('👥 Users & Technology').setFontSize(14).setFontWeight('bold');

  let nextRow = 3;

  // Device breakdown
  const deviceData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['deviceCategory'],
    ['totalUsers', 'sessions', 'engagementRate', 'bounceRate'],
    { orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }] }
  );

  if (deviceData.length > 0) {
    const headers = ['Device', 'Users', 'Sessions', 'Engagement Rate', 'Bounce Rate'];
    const formatted = deviceData.map(r => [r[0], r[1], r[2], `${(r[3]*100).toFixed(1)}%`, `${(r[4]*100).toFixed(1)}%`]);
    nextRow = writeTable(sheet, nextRow, 1, headers, formatted);

    const pieRange = sheet.getRange(3, 1, formatted.length + 1, 2);
    addPieChart(sheet, 'Users by Device', pieRange, 3, 7);
    nextRow += 2;
  }

  // Browser
  const browserData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['browser'],
    ['totalUsers', 'sessions'],
    { orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }], limit: 10 }
  );

  if (browserData.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Top Browsers').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    nextRow = writeTable(sheet, nextRow, 1, ['Browser', 'Users', 'Sessions'], browserData);
    nextRow += 2;
  }

  // Operating System
  const osData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['operatingSystem'],
    ['totalUsers', 'sessions'],
    { orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }], limit: 10 }
  );

  if (osData.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Operating Systems').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    nextRow = writeTable(sheet, nextRow, 1, ['OS', 'Users', 'Sessions'], osData);
    nextRow += 2;
  }

  // Country
  const countryData = runGA4Report(
    CONFIG.GA4_PROPERTY_ID,
    [{ startDate, endDate }],
    ['country'],
    ['totalUsers', 'sessions', 'engagementRate'],
    { orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }], limit: 15 }
  );

  if (countryData.length > 0) {
    sheet.getRange(nextRow, 1).setValue('Top Countries').setFontSize(12).setFontWeight('bold');
    nextRow += 1;
    const headers = ['Country', 'Users', 'Sessions', 'Engagement Rate'];
    const formatted = countryData.map(r => [r[0], r[1], r[2], `${(r[3]*100).toFixed(1)}%`]);
    writeTable(sheet, nextRow, 1, headers, formatted);
  }
}
