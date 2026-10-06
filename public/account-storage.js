(() => {
  function scope(storage, userId) {
    if (!userId) return storage;
    const prefix = 'novelking.user.' + userId + '.';
    return Object.freeze({
      getItem: key => storage.getItem(prefix + key),
      setItem: (key, value) => storage.setItem(prefix + key, value),
      removeItem: key => storage.removeItem(prefix + key),
    });
  }
  window.NovelKingAccountStorage = { scope };
})();
