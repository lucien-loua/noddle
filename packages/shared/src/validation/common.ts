// Hoisted to module level: a regex rebuilt on every call gets recompiled
// on every validation.
export const BRANCH_FORBIDDEN_CHARS = /[\s~^:?*[\\]/;
export const GIT_SSH_URL = /^git@[\w.-]+:/;
export const HTTPS_URL = /^https:\/\//;
export const HTTP_OR_HTTPS_URL = /^https?:\/\//;
export const LEADING_SLASHES = /^\/+/;
export const REGISTRY_HOST = /^[a-z0-9][a-z0-9.-]*(:\d{1,5})?$/i;
export const TRAILING_SLASHES = /\/+$/;
