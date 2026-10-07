(() => {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  window.NovelKingNavigation = {
    create() {
      let sequence = 0;
      return {
        begin(root, label) {
          const ticket = ++sequence, content = root.cloneNode(false);
          content.className = 'content';
          content.innerHTML = `<section class="page-loading" role="status"><span class="loading-ring" aria-hidden="true"></span><h1>${escape(label)}</h1><p>正在读取…</p></section>`;
          root.replaceWith(content);
          return { content, active: () => sequence === ticket && content.isConnected };
        }
      };
    }
  };
})();
