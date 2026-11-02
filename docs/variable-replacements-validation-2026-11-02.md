# Remplacement des variables — MCP 0.15.0, 2 novembre 2026

## Réglage identifié

Le remplacement lorsqu'un contact n'a pas de valeur est un réglage du compte :
`user_profile.datafields_replacement`. Il n'appartient pas à la définition du
champ et ne nécessite aucun bulk-set des données de contacts.

Le Swagger API actuel décrit `PUT /users/me` avec `mcp:write`, limité strictement
à `datafields_replacement` pour les appels OAuth MCP. Le contrat MCP ajoute cette
seule opération (250 au total) et la limite également côté MCP, sur tous les modes
d'authentification : autres propriétés du profil et paramètres de requête refusés.
Le générateur conserve les termes variable/replacement/default/fallback pour que
l'opération reste trouvable par `list_api_endpoints`.

## Outils

- `get_variable_replacements` : lecture/recherche/pagination des champs et des
  valeurs enregistrées, avec identifiants et placeholders ; aucun ID de liste requis.
- `set_variable_replacements` : fusion de changements ciblés avec la configuration
  complète existante. Exemple : `{"replacements":[{"field":"Civilité","replacement":"Mr/Mme"}]}`.
  Aperçu local ; `confirm:true` pour enregistrer. Une valeur vide retire uniquement
  le remplacement ciblé. Les contacts ne sont pas réécrits.

Les deux outils figurent dans les profils public et privé. Le setter demande
`mcp:read mcp:write`, car il lit les préférences et les champs avant d'écrire.
En OAuth privé, les écritures exigent la révision du compte actif comme les autres
outils. La configuration fusionnée est limitée à 65535 octets UTF-8, sans perte
silencieuse. Les champs ambigus, changements en doublon et préférences illisibles
sont refusés. Un ancien champ devenu inaccessible n'est pas supprimé implicitement.
Les lectures longues utilisent des aperçus explicites ; les écritures utilisent
toujours les valeurs complètes. Les changements concurrents ne sont pas verrouillés
atomiquement par l'API.

## Recette réelle

Transport : **MCP stdio local** via le SDK officiel, API réelle
`https://app.api-magileads.net`, identifiants du compte de démonstration fournis
localement. Aucun secret stocké dans les sources, les rapports ou les sorties.

| Vérification | Résultat |
| --- | --- |
| Identité de démonstration | Compte **777**, contrôlé avant les écritures |
| Configuration initiale | Deux remplacements enregistrés |
| Résolution de Civilité | Champ **2**, identifiant `civility`, placeholder `%civility%` |
| Aperçu sans confirmation | Configuration inchangée, vérifiée par relecture |
| Enregistrement d'une valeur de test et relecture | OK |
| Conservation de tous les autres remplacements | Comparaison complète réussie |
| Répétition de la même valeur via le placeholder | `unchanged:true`, sans nouvel enregistrement |
| Suppression du seul remplacement Civilité | OK ; les autres préférences restent présentes |
| Restauration de la configuration d'origine | Tableau initial restauré et comparé exactement |

Aucun message envoyé, aucune campagne démarrée, aucune donnée de contact modifiée.
Le script reproductible `scripts/check-variable-replacements.ts` lit les identifiants
uniquement depuis l'environnement. Il reste en lecture seule sans `--allow-update`.
La restauration refuse d'écraser une configuration dont les changements ne
correspondent plus à ceux attendus de la recette.

## Validation automatique et limites

**129 tests réussis, zéro échec** ; typecheck du serveur et du script de recette OK.
Les tests HTTP/OAuth simulés vérifient notamment l'union des scopes, les aperçus
locaux, les paramètres de profil interdits avant échange/appel API, l'absence de
repli vers des modifications de contacts, la conservation des valeurs et la
révision/identité du compte switché.

Le service déployé n'a pas été mis à jour pendant cette recette. La compatibilité
de bout en bout des nouveaux outils en **HTTP OAuth réel reste à vérifier après
déploiement**. Le Swagger annonce les restrictions nécessaires ; les tests simulés
et le stdio ne prouvent pas leur application par un Token Exchange de production.
Après déploiement, rafraîchir le catalogue du client, lire les remplacements puis
confirmer une modification sur un compte de démonstration explicitement choisi.
