const TRACKED_FILES = [
  'vibe-coding-lead-magnet.pdf',
  'vibe-coding-10-prompts.pdf',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/dl/')) {
      return new Response('Not found', { status: 404 });
    }

    const file = url.pathname.slice(4); // strip "/dl/"

    if (!TRACKED_FILES.includes(file)) {
      return Response.redirect(`${url.origin}/${file}`, 302);
    }

    // Increment daily counter
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `${today}:${file}`;
    const dailyCount = parseInt((await env.DOWNLOADS.get(dailyKey)) || '0');
    await env.DOWNLOADS.put(dailyKey, String(dailyCount + 1), {
      expirationTtl: 60 * 60 * 24 * 90, // keep 90 days
    });

    // Increment all-time counter
    const totalKey = `total:${file}`;
    const totalCount = parseInt((await env.DOWNLOADS.get(totalKey)) || '0');
    await env.DOWNLOADS.put(totalKey, String(totalCount + 1));

    // Redirect to actual PDF
    return Response.redirect(`${url.origin}/${file}`, 302);
  },

  async scheduled(event, env) {
    const { startDate, endDate, monthLabel, days } = previousMonthRange();

    // Sum each tracked file's daily counters across the previous month
    const downloads = [];
    for (const file of TRACKED_FILES) {
      let monthly = 0;
      for (const day of days) {
        monthly += parseInt((await env.DOWNLOADS.get(`${day}:${file}`)) || '0');
      }
      const total = parseInt((await env.DOWNLOADS.get(`total:${file}`)) || '0');
      const name = file.replace('.pdf', '').replace(/-/g, ' ');
      downloads.push({ name, file, monthly, total });
    }

    // Fetch page analytics from Cloudflare GraphQL API for the month range
    const analytics = await fetchAnalytics(env, startDate, endDate);

    // Build and send email
    const html = buildEmail(monthLabel, analytics, downloads);
    await sendEmail(env, monthLabel, html);
  },
};

function previousMonthRange(now = new Date()) {
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthEnd = new Date(currentMonthStart.getTime() - 86400000);
  const prevMonthStart = new Date(Date.UTC(prevMonthEnd.getUTCFullYear(), prevMonthEnd.getUTCMonth(), 1));

  const days = [];
  const cursor = new Date(prevMonthStart);
  while (cursor <= prevMonthEnd) {
    days.push(cursor.toISOString().split('T')[0]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const monthLabel = `${prevMonthStart.getUTCFullYear()}-${String(prevMonthStart.getUTCMonth() + 1).padStart(2, '0')}`;

  return {
    startDate: prevMonthStart.toISOString().split('T')[0],
    endDate: prevMonthEnd.toISOString().split('T')[0],
    monthLabel,
    days,
  };
}

async function fetchAnalytics(env, startDate, endDate) {
  const query = `query GetAnalytics($accountTag: String!, $startDate: Date!, $endDate: Date!, $siteTag: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        rumPageloadEventsAdaptiveGroups(
          filter: {
            date_geq: $startDate
            date_leq: $endDate
            siteTag: $siteTag
          }
          limit: 10
          orderBy: [count_DESC]
        ) {
          count
          dimensions {
            requestPath
          }
        }
        rumPerformanceEventsAdaptiveGroups(
          filter: {
            date_geq: $startDate
            date_leq: $endDate
            siteTag: $siteTag
          }
          limit: 1
        ) {
          count
          sum {
            visits
          }
        }
      }
    }
  }`;

  try {
    const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          accountTag: env.CF_ACCOUNT_ID,
          startDate,
          endDate,
          siteTag: env.CF_SITE_TAG || 'eb8d4a107a2146949fee35f1b0a9050f',
        },
      }),
    });

    const data = await resp.json();
    const accounts = data?.data?.viewer?.accounts?.[0];

    const perfGroups = accounts?.rumPerformanceEventsAdaptiveGroups?.[0];
    const pageViews = perfGroups?.count || 0;
    const visitors = perfGroups?.sum?.visits || 0;

    const topPages = (accounts?.rumPageloadEventsAdaptiveGroups || []).map((g) => ({
      path: g.dimensions.requestPath || '/',
      views: g.count,
    }));

    return { pageViews, visitors, topPages };
  } catch (e) {
    return { pageViews: 0, visitors: 0, topPages: [], error: e.message };
  }
}

function buildEmail(monthLabel, analytics, downloads) {
  const totalDownloadsMonth = downloads.reduce((sum, d) => sum + d.monthly, 0);

  const downloadRows = downloads
    .map(
      (d) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #1e1e2e; color: #e0e0e8;">${d.name}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #1e1e2e; color: #00d4aa; text-align: center;">${d.monthly}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #1e1e2e; color: #8888a0; text-align: center;">${d.total}</td>
      </tr>`
    )
    .join('');

  const topPageRows = analytics.topPages
    .slice(0, 5)
    .map(
      (p) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #1e1e2e; color: #e0e0e8; font-family: monospace; font-size: 13px;">${p.path}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #1e1e2e; color: #00d4aa; text-align: center;">${p.views}</td>
      </tr>`
    )
    .join('');

  return `
  <div style="background: #0a0a0f; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
    <div style="max-width: 600px; margin: 0 auto;">
      <h1 style="color: #00d4aa; font-size: 18px; font-family: monospace; margin-bottom: 4px;">// Cooper Tech Monthly Report</h1>
      <p style="color: #8888a0; font-size: 14px; margin-top: 0;">${monthLabel}</p>

      <div style="background: #12121a; border: 1px solid #1e1e2e; border-radius: 6px; padding: 24px; margin-bottom: 20px;">
        <h2 style="color: #e0e0e8; font-size: 15px; margin-top: 0;">Site Traffic</h2>
        <table style="width: 100%;">
          <tr>
            <td style="padding: 12px; text-align: center;">
              <div style="color: #00d4aa; font-size: 28px; font-weight: bold;">${analytics.pageViews}</div>
              <div style="color: #8888a0; font-size: 12px; margin-top: 4px;">Page Views</div>
            </td>
            <td style="padding: 12px; text-align: center;">
              <div style="color: #00d4aa; font-size: 28px; font-weight: bold;">${analytics.visitors}</div>
              <div style="color: #8888a0; font-size: 12px; margin-top: 4px;">Unique Visitors</div>
            </td>
            <td style="padding: 12px; text-align: center;">
              <div style="color: #00d4aa; font-size: 28px; font-weight: bold;">${totalDownloadsMonth}</div>
              <div style="color: #8888a0; font-size: 12px; margin-top: 4px;">Downloads</div>
            </td>
          </tr>
        </table>
      </div>

      <div style="background: #12121a; border: 1px solid #1e1e2e; border-radius: 6px; padding: 24px; margin-bottom: 20px;">
        <h2 style="color: #e0e0e8; font-size: 15px; margin-top: 0;">Guide Downloads</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 8px 12px; text-align: left; color: #8888a0; font-size: 12px; border-bottom: 1px solid #1e1e2e;">Guide</th>
              <th style="padding: 8px 12px; text-align: center; color: #8888a0; font-size: 12px; border-bottom: 1px solid #1e1e2e;">${monthLabel}</th>
              <th style="padding: 8px 12px; text-align: center; color: #8888a0; font-size: 12px; border-bottom: 1px solid #1e1e2e;">All Time</th>
            </tr>
          </thead>
          <tbody>${downloadRows}</tbody>
        </table>
      </div>

      ${topPageRows ? `
      <div style="background: #12121a; border: 1px solid #1e1e2e; border-radius: 6px; padding: 24px; margin-bottom: 20px;">
        <h2 style="color: #e0e0e8; font-size: 15px; margin-top: 0;">Top Pages</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 8px 12px; text-align: left; color: #8888a0; font-size: 12px; border-bottom: 1px solid #1e1e2e;">Path</th>
              <th style="padding: 8px 12px; text-align: center; color: #8888a0; font-size: 12px; border-bottom: 1px solid #1e1e2e;">Views</th>
            </tr>
          </thead>
          <tbody>${topPageRows}</tbody>
        </table>
      </div>` : ''}

      ${analytics.error ? `<p style="color: #ff6b6b; font-size: 13px;">Analytics API error: ${analytics.error}</p>` : ''}

      <p style="color: #8888a0; font-size: 12px; text-align: center; margin-top: 24px;">Cooper Tech LLC — Monthly Analytics Report</p>
    </div>
  </div>`;
}

async function sendEmail(env, monthLabel, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Cooper Tech Analytics <analytics@coopertech.cc>',
      to: [env.NOTIFY_EMAIL || 'josh@coopertech.cc'],
      subject: `Monthly Report — ${monthLabel}`,
      html,
    }),
  });

  if (!resp.ok) {
    console.error('Email send failed:', await resp.text());
  }
}
