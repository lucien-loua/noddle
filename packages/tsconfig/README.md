# @noddle/tsconfig

Config TypeScript partagée. Chaque paquet l'étend :

```json
{
  "extends": "@noddle/tsconfig/base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src/**/*.ts"]
}
```

Les commentaires ne sont pas dans `base.json` : les éditeurs et Biome traitent
`.json` en JSON strict, et les commentaires y cassent le parsing. Les choix non
évidents sont donc ici.

## `erasableSyntaxOnly`

Le seul réglage vraiment structurant, et il n'est pas cosmétique.

Il interdit toute syntaxe TypeScript qui **génère du code** au lieu de
disparaître avec les types : parameter properties
(`constructor(private readonly x: T)`), `enum`, `namespace`, decorators hérités.

C'est exactement la contrainte du mode *strip-only* de Node, qui retire les
annotations sans rien transformer. Et `apps/worker` tourne sur Node — décidé par
mesure, pas par préférence : `dockerode` ne fonctionne pas sur Bun à travers un
tunnel SSH (voir `.claude/CLAUDE.md`).

Sans ce flag, l'erreur ne se manifeste qu'à l'exécution, sous la forme d'un
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` au chargement du module. Elle a déjà coûté un
aller-retour sur un `constructor(readonly host: string)`.

## `allowImportingTsExtensions`

Les imports portent l'extension `.ts` explicitement (`from "./index.ts"`). Node
en mode strip-only et Bun l'exigent tous les deux.
