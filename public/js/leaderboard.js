(function(){
  const tableBody = document.getElementById('board-body');
  const refresh = document.getElementById('refresh');
  const loading = document.getElementById('loading');

  // fixed: top 20, descending
  async function load() {
    tableBody.innerHTML = '';
    loading.style.display = 'inline';
    try {
      const url = `/api/leaderboard/chess?limit=20&order=desc`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Fetch failed ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid response');
      data.forEach((row, idx) => {
        const tr = document.createElement('tr');
        tr.style.borderTop = '1px solid #e6e2da';
        const rank = document.createElement('td'); rank.style.padding = '8px 12px'; rank.textContent = idx + 1;
        const name = document.createElement('td'); name.style.padding = '8px 12px'; name.textContent = row.username || '';
        const pts = document.createElement('td'); pts.style.padding = '8px 12px'; pts.textContent = (row.chess_points || 0);
        tr.appendChild(rank); tr.appendChild(name); tr.appendChild(pts);
        tableBody.appendChild(tr);
      });
    } catch (e) {
      tableBody.innerHTML = `<tr><td colspan="3" style="padding:12px; color:#a00">Error loading leaderboard: ${e.message}</td></tr>`;
      console.error('leaderboard load error', e);
    } finally {
      loading.style.display = 'none';
    }
  }

  refresh.addEventListener('click', load);
  // initial
  load();
})();
