# Switch OAuth revendeur — diagnostic réel du 27 octobre 2026

## Résultat

Test sur les **serveurs HTTP déployés**, version MCP **0.14.0**, avec le même
compte d'origine **777** et des autorisations OAuth neuves pour les deux audiences.
Le même client OAuth public de recette est utilisé pour les deux domaines à
chaque passage. Consentement, Authorization Code et PKCE S256 aboutissent.

| Vérification | Magileads | Surleads |
| --- | --- | --- |
| Ressource | `https://mcp.magileads.io/mcp` | `https://mcp.surleads.com/mcp` |
| Santé / métadonnées / version | OK, 0.14.0 | OK, 0.14.0 |
| Compte OAuth original et lecture métier | 777 | 777 |
| `list_switchable_accounts` sans paramètre | IDs **11, 777, 4192** | ID **777** uniquement |
| Même outil avec `limit:100`, toutes les pages | Mêmes 3 IDs, fin de pagination | Même ID 777, fin de pagination |
| Cible 4192 dans la liste autorisée | Oui | Non |
| Switch réel 777 → 4192, lecture de l'identité, retour 777 | **Validé** | **Non tenté**, cible absente de la liste autorisée |

Sur Surleads, la liste n'est donc pas techniquement vide pendant ce test : elle ne
contient que le compte d'origine. **Aucun autre compte n'est proposé au switch.**
Cette observation ne prouve pas le résultat d'un autre utilisateur que 777.

Le compte original est restauré après le switch Magileads. Les jetons de toutes
les autorisations OAuth de recette ont été révoqués après vérification. Aucun
modèle, campagne, message ou contact n'a été créé/modifié par cette recette.

## Où vérifier

Dans le MCP 0.14.0, `src/http.ts` transmet la ressource du domaine appelé à
`loadAccountSession`. `src/oauth/account-context.ts` appelle ensuite le contrôle
privé sur l'origine de l'issuer, avec cette même ressource exacte :

```http
POST /oauth/mcp/switchable-accounts
Authorization: Basic <client confidentiel du serveur, ne pas journaliser>
Content-Type: application/json

{
  "subject_token": "<bearer MCP original lié à ce domaine, ne pas journaliser>",
  "resource": "https://mcp.surleads.com/mcp",
  "limit": 100
}
```

Le MCP valide la forme de la réponse puis la restitue ; il ne filtre pas les IDs
par revendeur et ne retire pas le compte original. Il ne remplace pas une liste
vide par celle de Magileads. La comparaison isole donc une différence de sélection
API/configuration liée à la ressource, plutôt qu'un échec du consentement ou une
suppression de cibles dans ce code MCP.

Ce test n'a pas capturé le trafic privé du conteneur ni inspecté la base API :
la cause métier exacte du filtrage reste à confirmer par le backend.

## Message à transmettre au backend

Avec l'acteur original **777**, les ressources Magileads et Surleads sont acceptées,
le contrôle de contexte et les lectures métier fonctionnent. Pourtant la liste
des cibles autorisées passe de **[11, 777, 4192]** à **[777]** quand la ressource
devient `https://mcp.surleads.com/mcp`. Résultat identique sans paramètres et avec
`limit:100`, sans page suivante.

Merci de vérifier dans `POST /oauth/mcp/switchable-accounts` :

1. La politique de délégation de l'acteur 777 et la cible 4192 pour cette ressource.
2. L'association du domaine MCP au bon revendeur et les appartenances/droits
   effectifs pris en compte pour calculer les cibles.
3. La configuration du client confidentiel pour le contrôle de compte sur chaque
   ressource, distincte de la découverte publique des domaines.
4. Si la restriction par domaine est volontaire, préciser quels comptes sont
   attendus pour ce revendeur ; sinon corriger le filtre/configuration côté API.

Conserver la validation d'audience exacte et les droits réels. Ne pas ouvrir
automatiquement tous les comptes de Magileads sur les domaines revendeurs.
Une reconnexion OAuth n'a pas levé cette différence pendant nos deux passages.

## Reproduction

`scripts/check-reseller-switching.ts` prend les identifiants de démonstration
uniquement via `MAGILEADS_EMAIL` et `MAGILEADS_PASSWORD`, plus
`MAGILEADS_TEST_EXPECTED_USER_ID` et `MAGILEADS_TEST_TARGET_USER_ID`.
Sans option : lecture seule des comptes métier. `--allow-switch` ajoute le switch
uniquement si la cible figure dans la liste autorisée, puis le retour explicite.
Le rapport JSON facultatif (`MAGILEADS_TEST_REPORT_PATH`) ne contient ni jetons,
secrets, codes, révisions ou curseurs.

Traces sans secrets : [aller-retour réel Magileads](reseller-switching-live-2026-10-27.json)
et [comparaison des listes par défaut/maximales](reseller-switching-readonly-2026-10-27.json).
