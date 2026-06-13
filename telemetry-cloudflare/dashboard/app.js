const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
fetch('/api/dashboard', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then((data) => {
    const latest = new Map();
    for (const row of data.ecosystem || [])
      if (!latest.has(`${row.metric}:${row.dimension}`))
        latest.set(`${row.metric}:${row.dimension}`, row);
    const card = (label, value) =>
      `<article><span>${esc(label)}</span><strong>${Number(value || 0).toLocaleString()}</strong></article>`;
    const calls = (data.usage || []).reduce((sum, row) => sum + Number(row.count || 0), 0);
    const errors = (data.usage || [])
      .filter((row) => row.outcome !== 'success')
      .reduce((sum, row) => sum + Number(row.count || 0), 0);
    document.getElementById('cards').innerHTML = [
      card('Opted-in active installs, 30d', data.reach?.monthly_active_installs),
      card('npm downloads, 7d', latest.get('npm_downloads_7d:')?.value),
      card('npm downloads, 30d', latest.get('npm_downloads_30d:')?.value),
      card('GitHub stars', latest.get('github_stars:')?.value),
      card('Opted-in calls, 30d', calls),
      card('Coarse error rate, %', calls ? ((errors / calls) * 100).toFixed(1) : 0),
    ].join('');
    document.getElementById('usage').innerHTML = (data.usage || [])
      .map(
        (r) =>
          `<tr><td>${esc(r.package_version)}</td><td>${esc(r.surface)}</td><td>${esc(r.network)}</td><td>${esc(r.operation)}</td><td>${esc(r.outcome)}</td><td>${Number(r.count).toLocaleString()}</td></tr>`,
      )
      .join('');
    document.getElementById('ecosystem').innerHTML = (data.ecosystem || [])
      .map(
        (r) =>
          `<tr><td>${esc(r.day)}</td><td>${esc(r.metric)}</td><td>${esc(r.dimension)}</td><td>${Number(r.value).toLocaleString()}</td></tr>`,
      )
      .join('');
  })
  .catch(() => {
    document.getElementById('cards').innerHTML =
      '<article><strong>Dashboard data unavailable</strong></article>';
  });
