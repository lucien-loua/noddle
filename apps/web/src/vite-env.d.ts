/// <reference types="vite/client" />

// Déclare `*?url`, `*.css` et `import.meta.env`.
//
// Passé par une référence triple-slash et non par `types` dans tsconfig.json :
// `"types": ["vite/client"]` ne résout pas ce sous-chemin sous TypeScript 7,
// et l'échec est silencieux — le seul symptôme est un `?url` introuvable.
