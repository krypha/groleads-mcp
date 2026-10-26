# Switch de compte OAuth MCP — contrat d'intégration API

Contrat aligné sur le compte rendu du back du **26 octobre 2026**
(`mcp-account-switching-consignes-rim.md`). Livraison API annoncée par l'équipe ;
la compatibilité de bout en bout doit être prouvée par une recette authentifiée.
Le MCP 0.13.0 utilise automatiquement ce parcours en HTTP OAuth privé, profil
`full`. Aucune variable d'activation, nouvelle page de consentement ou reconnexion
forcée des autorisations existantes n'est nécessaire.

## Message court à transmettre au back

Le MCP dispose maintenant des outils `list_switchable_accounts`,
`get_active_account`, `switch_account` et `return_to_original_account`.
Le compte rendu API indique l'implémentation des points suivants, à recetter :

1. Fournir les trois opérations privées décrites ci-dessous, authentifiées avec
   les identifiants Basic du client confidentiel existant.
2. Persister le compte actif par **autorisation/connexion OAuth d'origine et
   ressource MCP exacte**, avec une révision et une mise à jour atomique.
3. Étendre le Token Exchange pour produire un jeton API limité au compte actif,
   aux scopes demandés et aux permissions effectives, en conservant l'acteur original.
4. Vérifier cette délégation sur les routes métier et distinguer les erreurs de
   délégation d'un vrai jeton OAuth d'origine invalide.

Ne pas simplement retourner le JWT de switch du navigateur ni ouvrir les routes
d'administration au passthrough MCP. Vous pouvez réutiliser les règles métier de
`POST /users/switch/to/{user_id}` en interne, mais pas ses éventuels privilèges
de session web. Aucun format de réponse de cette ancienne route n'est présumé ici.

## Périmètre et stockage

- HTTP OAuth uniquement, profil `full`. Les clés API, stdio et le profil public
  ne gagnent aucun outil de switch. Avec `both`, seules les requêtes OAuth l'utilisent.
- La délégation dure **60 minutes après chaque sélection réussie**, y compris
  la sélection explicite du même compte, qui renouvelle le délai et la révision.
  L'API est la source de vérité ; aucun renouvellement automatique côté MCP.
- La liste et l'autorisation de switch sont déterminées par **l'acteur original**,
  jamais par le compte déjà switché : pas de chaînage d'usurpations.
- Vérifier les droits réels (admin revendeur, appartenance, cible active, politique
  de consentement/délégation). Un simple scope `mcp:write` ne suffit pas à autoriser
  l'accès à un autre compte. Les utilisateurs ordinaires ne doivent pas pouvoir
  énumérer ou sélectionner des comptes non autorisés.
- Stockage durable partagé entre les instances API : clé incluant issuer,
  utilisateur original, client OAuth, identifiant **stable de l'autorisation/grant**,
  et ressource MCP exacte. Le refresh ne change pas cette identité de connexion.
  Deux autorisations indépendantes du même utilisateur doivent rester isolées.
  Ne pas indexer seulement par user ID, par client ID, ni par hash du bearer courant.
- Le backend retrouve cette clé depuis le `subject_token` validé et son grant en
  base ; le MCP ne fournit aucun identifiant de grant choisi par l'assistant.
- `https://mcp.magileads.io/mcp` et `https://mcp.surleads.com/mcp` sont deux contextes
  distincts. Vérifier audience **unique et exacte**, ressource active et client
  confidentiel autorisé pour ce domaine, y compris sur chaque opération privée.
- À la première lecture : créer un contexte pointant vers le compte original.
  Ne pas réinitialiser ce choix à chaque lecture/refresh/redémarrage.
- Plusieurs chats utilisant la **même connexion OAuth et le même domaine** partagent
  ce choix. Il n'existe pas de session/chat ID MCP fiable dans le transport stateless.
  Une isolation par chat nécessiterait un autre contrat et le support du client.
- À révocation du grant, invalider ses contextes et jetons dérivés. À retrait des
  droits ou désactivation de cible, refuser les opérations déléguées sans basculer
  implicitement sur l'original. Le retour explicite doit rester possible.

## Authentification des opérations privées

Ces routes sont fixées sur **l'origine de `OAUTH_ISSUER`**, par exemple
`https://app.api-magileads.net`, même si l'issuer contient un chemin.
Pas de redirection HTTP. HTTPS obligatoire, sauf loopback pour les tests locaux.

```http
Authorization: Basic <client_secret_basic avec le client confidentiel existant>
Content-Type: application/json
Accept: application/json
```

Le Basic est identique à celui du Token Exchange (composants encodés selon OAuth).
Autoriser explicitement ce client à utiliser le contrôle de contexte ; **ne pas
exposer ces opérations aux clients publics** enregistrés via `/oauth/register`.

Chaque JSON contient :

```json
{
  "subject_token": "<bearer MCP original>",
  "resource": "https://mcp.surleads.com/mcp"
}
```

Le bearer original ne sert qu'aux opérations privées OAuth et au Token Exchange,
jamais aux routes métier. Vérifier signature, issuer, audience, expiration,
révocation/grant et scopes côté API aussi. Ne pas journaliser les corps, Basic,
jetons ou paramètres sensibles dans l'API, reverse proxy, APM ou traces d'erreurs.
Réponses `Cache-Control: no-store`. Les corps de réponse privés sont limités par
le MCP à 256 Kio, timeout 15 s ; éviter les traitements longs et paginer la liste.

## 1. Lire le contexte : POST /oauth/mcp/account-context

JSON : `subject_token` et `resource` seulement. Opération en lecture
(initialisation du contexte autorisée), scope `mcp:read` **ou** `mcp:write` : le
MCP la fait avant chaque appel d'outil, y compris les aperçus et le retour.
Pas d'appel sur `initialize` ou `tools/list`.

HTTP 200 :

```json
{
  "state": true,
  "context": {
    "revision": "rev_opaque_001",
    "original_account": { "id": 7, "first_name": "Alice", "last_name": "Martin" },
    "active_account": { "id": 42, "first_name": "Bob", "last_name": "Durand" },
    "is_switched": true
  }
}
```

- IDs : entiers positifs JSON, dans la plage sûre JavaScript ; pas de strings.
- Prénom/nom : strings, éventuellement vides, 256 caractères max chacune.
- `revision` : opaque, non réutilisée, 1–128 caractères `[A-Za-z0-9_-]`.
- `is_switched` vaut exactement `active_account.id !== original_account.id`.
- Renvoie **toujours le contexte connu**, même si la délégation vers la cible est
  expirée ou la cible désactivée. Sinon le MCP ne pourrait pas proposer le retour.
  La lecture du contexte n'accorde aucun accès métier à cette cible.
- Ne jamais renvoyer les secrets/tokens/credentials des comptes.

## 2. Lister : POST /oauth/mcp/switchable-accounts

Scope `mcp:read`. `get_active_account` accepte aussi `mcp:write` seul : l'absence
d'accès à la liste ne doit pas bloquer une sélection connue/autorisée ou le retour.
Même JSON, avec paramètres optionnels :

```json
{
  "subject_token": "<bearer MCP original>",
  "resource": "https://mcp.surleads.com/mcp",
  "search": "Bob",
  "limit": 25,
  "cursor": "<curseur opaque optionnel>"
}
```

`limit` 1–100 (défaut 25), recherche 200 caractères max, curseur 512 caractères max.
Pour suivre `next_cursor`, conserver la même recherche. HTTP 200 :

```json
{
  "state": true,
  "accounts": [{ "id": 42, "first_name": "Bob", "last_name": "Durand" }],
  "next_cursor": null
}
```

`next_cursor` est requis : `null` ou string non vide <= 512 caractères. Maximum
100 comptes par réponse. Pagination/filtrage côté API, uniquement sur les comptes
autorisés pour l'acteur original et ce contexte revendeur. Aucun changement de compte.

## 3. Switch / retour : PUT /oauth/mcp/account-context

Scope `mcp:write`, plus contrôle des permissions de délégation réelles.

```json
{
  "subject_token": "<bearer MCP original>",
  "resource": "https://mcp.surleads.com/mcp",
  "expected_revision": "rev_opaque_001",
  "target_user_id": 42
}
```

- `target_user_id` entier positif pour switcher, **null pour revenir à l'original**.
- Revalider la cible, les permissions actuelles, l'autorisation d'origine et la ressource.
- Comparer `expected_revision` et mettre à jour **atomiquement** ; si différente,
  HTTP 409 `account_context_changed`, aucune mutation. Une seule de deux requêtes
  concurrentes avec la même révision peut réussir.
- HTTP 200 : même enveloppe `state:true, context` que la lecture, avec une **nouvelle
  révision**, même pour un retour déjà sur l'original ou une sélection identique.
- `original_account.id` ne change jamais ; `active_account.id` correspond exactement
  à la cible ou à l'original si null. Une réponse incohérente est refusée par le MCP.
- Le retour utilise le bearer d'origine, jamais le jeton métier de la cible. Il doit
  marcher malgré une délégation expirée, une cible inactive ou des droits retirés.
- Le switch n'effectue aucune action métier et ne remplace/révoque pas le bearer
  original ni son refresh token. Journal d'audit : acteur, cible, client/grant,
  domaine, ancienne/nouvelle révision, horodatage, succès/refus, sans secrets.
- Une réponse perdue après commit rend le résultat incertain. Le MCP ne réessaie
  pas automatiquement : l'assistant doit relire le contexte avant toute autre action.

## 4. Extension du Token Exchange existant

Conserver RFC 8693, Basic interne, types de jeton, `resource=OAUTH_API_RESOURCE`
et union exacte des scopes métier. Lorsque le switch MCP est activé, le MCP ajoute :

```text
account_context_revision=rev_opaque_002
mcp_resource=https://mcp.surleads.com/mcp
```

`mcp_resource` désigne l'audience source MCP exacte ; `resource` reste l'audience
API cible. Vérifier les deux, le subject token, son grant et les permissions de
l'acteur/cible. Comparer la révision au stockage avant d'émettre le jeton. Une
extension fournie mais incomplète, inconnue ou périmée doit échouer, sans repli.

Compatibilité : **si les deux champs d'extension sont absents**, garder l'échange
historique vers **le compte original**, même si un contexte switché existe.
Si un seul champ est fourni, refuser. Pas d'héritage implicite du switch pour les
anciens clients ou les profils publics qui n'utilisent pas ce parcours privé.

Réponse d'échange réussie :

```json
{
  "access_token": "<jeton API délégué, court et limité>",
  "token_type": "Bearer",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "expires_in": 300,
  "scope": "mcp:read mcp:write",
  "account_context_revision": "rev_opaque_002",
  "actor_user_id": 7,
  "effective_user_id": 42
}
```

Les trois derniers champs sont **obligatoires en mode contexte**, y compris quand
le compte actif est l'original. Le MCP refuse avant l'appel métier si le binding
révision/acteur/cible diffère ou manque. Le MCP n'utilise **aucun cache de jeton
échangé** dans ce mode et n'envoie jamais le token dans les résultats des outils.
Le mode historique garde son cache existant.

Les jetons API durent au plus **300 secondes**, moins si l'original ou la
délégation expire plus tôt. Dans le jeton API, `act.sub` désigne le client interne ;
utiliser **`actor_user_id`** pour l'utilisateur original, pas `act.sub`.

Le jeton délégué porte/vérifie côté API : audience API, utilisateur effectif,
acteur original, grant/client, domaine source, révision, expiration, scopes limités.
Il ne doit pas autoriser les routes admin/secret ou dépasser les permissions de
la cible / la politique de délégation de l'acteur / les scopes du grant original.
Les autorisations élevées de l'acteur ne doivent pas « déborder » sur la cible.
Les scopes ne changent pas : `mcp:write` n'implique pas `mcp:read`.

## 5. Middleware métier et erreurs

Sur **toutes les routes métier utilisées**, résoudre l'utilisateur depuis le jeton
échangé (cible), tout en conservant l'acteur pour l'audit. Ne jamais reprendre
l'utilisateur d'une session navigateur ou un état global de switch.
Vérifier droits, état de la cible, révocation du grant et révision actuelle.
Refuser les anciens jetons après changement de révision ; pour une écriture,
coupler la vérification de révision et l'autorisation de mutation de manière à
fermer la course entre switch et exécution. Les appels composés doivent tous rester
liés au même compte/révision. Une action déjà engagée ne doit jamais changer de cible.

Erreurs privées : JSON `{ "error": "<code>" }`, pas de bearer dans les descriptions.

| Situation | Statut / code API attendu | Comportement MCP |
| --- | --- | --- |
| Bearer/grant original invalide ou révoqué sur contrôle privé | 400 `invalid_subject_token` | 401 OAuth : reconnexion légitime |
| Bearer/grant original invalide à l'échange | 400 `invalid_grant` existant | 401 OAuth |
| Basic interne invalide | 401 `invalid_client` | Erreur de configuration, pas de reconnexion utilisateur |
| Paramètres invalides / extensions incomplètes | 400 `invalid_request` | Erreur d'intégration, aucun repli |
| Ressource invalide / non autorisée | 400 `invalid_target` | Signaler le problème de domaine/client, aucun repli |
| Cible interdite | 403 `delegation_denied` | Erreur d'outil, pas de fallback |
| Délégation expirée | 403 `delegation_expired` | Erreur d'outil, retour explicite possible |
| Cible désactivée / supprimée | 403 `target_unavailable` | Erreur d'outil, retour explicite possible |
| Révision périmée, y compris sur routes métier | 409 `account_context_changed` | Erreur d'outil, relire avant une nouvelle confirmation |
| API indisponible / limite | 5xx / 429 | Pas de reconnexion ni de retry automatique ; contrôle initial/échange : HTTP 503 côté MCP |
| Route métier renvoie malgré tout 401 en étant switché | 401 | HTTP MCP 200, `isError:true`, code `switched_account_unauthorized`, sans `WWW-Authenticate` |

Ne pas utiliser `invalid_grant` pour un refus de la cible : cela demanderait à tort
de reconnecter l'original. Sur un compte non switché, les 401 métier gardent le
comportement OAuth historique. Le MCP continue toujours à vérifier le bearer
original : si celui-ci expire réellement, le switch ne contourne pas la reconnexion.

## Ce que renvoie le MCP et recette

Chaque résultat d'outil traité en mode switch contient `account_context` avec les
deux identités et la révision, y compris les erreurs d'outil et erreurs de validation
SDK. Les erreurs d'authentification/protocole/indisponibilité avant chargement du
contexte n'ont pas forcément cette enveloppe. Après un changement de compte au
résultat incertain, `selection_status:"unknown_after_change"` indique que les
identités affichées sont le dernier instantané connu : relire avec `get_active_account`.
Cette propriété est ajoutée par le MCP, pas requise dans les réponses API.

Les écritures confirmées requièrent `account_revision`, fourni par un aperçu ou
`get_active_account`. Une révision manquante/périmée bloque avant tout échange/action.
Le back doit néanmoins assurer les vérifications atomiques : cette garde MCP seule
ne suffit pas. L'assistant reçoit l'instruction d'annoncer le compte switché, mais
le MCP ne contrôle pas le rendu des réponses sans appel d'outil chez Claude/ChatGPT.

À tester avec des comptes de démonstration autorisés, sans envoi de campagne :

1. Admin revendeur : liste -> aperçu switch -> confirmation -> `get_account_overview`
   renvoie la cible ; confirmer une création de modèle test dans ce compte seulement.
2. Une liste/contact/modèle inaccessible à la cible reste refusé malgré les droits
   de l'acteur. Aucun accès admin par le jeton délégué.
3. Refus de cible / 401 métier / délégation expirée : pas de « Reconnecter », pas de
   retry, pas de retour implicite. Retour explicite vers l'original fonctionnel.
4. Changer de compte entre aperçu et confirmation / deux switches concurrents :
   une révision périmée échoue, aucune écriture sur le mauvais compte.
5. Refresh, redémarrage et deux replicas : même contexte. Nouvelle autorisation,
   autre utilisateur, autre client ou domaine revendeur : contextes distincts.
6. Révoquer le grant original : le switch ne donne plus d'accès. Retirer le domaine
   MCP actif : aucun échange/contrôle ne le contourne.
7. Timeout après commit de switch : relire le compte réel, ne pas rejouer le PUT
   automatiquement. Ancien échange sans extensions : uniquement l'original.

Avant de déployer le MCP privé, l'équipe API doit appliquer la migration puis
vérifier la disponibilité et l'autorisation du client pour chaque ressource exacte :

```shell
./manager cli artisan migrate --path=database/migrations/2026_10_23_120000_add_mcp_account_switching.php --force
./manager cli artisan oauth:check-readiness
./manager cli artisan oauth:authorize-mcp-account-switching <client_id> https://mcp.magileads.io/mcp
```

Répéter la dernière commande pour chaque domaine revendeur. Cette autorisation
est **distincte de la découverte des domaines** et des droits de l'utilisateur.
Commandes à exécuter côté API, pas dans le dépôt MCP. Ensuite recetter avec :

```dotenv
MCP_HTTP_AUTH=oauth
MCP_TOOL_PROFILE=full
```

`both` est également accepté ; garder les cinq `OAUTH_*` et le contrat de
découverte des domaines existants. Aucun nouveau secret ni flag d'activation.
Le profil `public`, stdio et les clés API restent hors de ce parcours. Ne pas
considérer une réussite des tests locaux comme une preuve du déploiement API.
