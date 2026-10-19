// Gespeichertes Farbschema vor dem ersten Zeichnen setzen (verhindert Aufblitzen)
try { const t = localStorage.getItem('hb-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* egal */ }
