/**
 * History sidebar rendering.
 * Pure function of (rows, activeId) → DOM, with delegated click handling.
 */

import { escapeHtml, formatFullTime, formatHistoryTime } from '../util.js';

/**
 * @param {Object} options
 * @param {HTMLElement} options.listEl
 * @param {HTMLElement} options.countEl
 * @param {Array<{id:string,title:string,updatedAt:number,turnCount:number}>} options.rows
 * @param {string|null} options.activeId
 * @param {(id:string)=>void} options.onOpen
 * @param {(id:string)=>void} options.onDelete
 */
export function renderSidebar({ listEl, countEl, rows, activeId, onOpen, onDelete }) {
  countEl.textContent = String(rows.length);

  if (!rows.length) {
    listEl.innerHTML =
      '<li class="history-empty">No chats yet. Your conversations are saved here automatically.</li>';
    listEl.onclick = null;
    return;
  }

  listEl.innerHTML = rows
    .map((row) => {
      const active = row.id === activeId ? ' is-active' : '';
      const title = escapeHtml(row.title || 'New chat');
      const time = escapeHtml(formatHistoryTime(row.updatedAt));
      const full = escapeHtml(formatFullTime(row.updatedAt));
      const turns = Number(row.turnCount) || 0;
      return `<li class="history-item${active}" data-id="${escapeHtml(row.id)}">
        <button class="history-open" type="button" title="${full} · ${turns} turn${turns === 1 ? '' : 's'}">
          <span class="history-title">${title}</span>
          <span class="history-time">${time}</span>
        </button>
        <button class="history-delete" type="button" title="Delete chat" aria-label="Delete chat" data-delete="${escapeHtml(row.id)}">
          <svg class="ico" aria-hidden="true"><use href="#i-trash" /></svg>
        </button>
      </li>`;
    })
    .join('');

  listEl.onclick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const deleteBtn = target.closest('[data-delete]');
    if (deleteBtn) {
      event.stopPropagation();
      onDelete(deleteBtn.getAttribute('data-delete'));
      return;
    }
    const item = target.closest('.history-item');
    if (item) onOpen(item.getAttribute('data-id'));
  };
}
