# Recette du switch MCP — 26 octobre 2026

## Verdict

**Code MCP : conforme aux vérifications locales. Intégration réelle complète :
NON VALIDÉE, ne pas la déclarer opérationnelle sur la seule base de ces tests.**

La recette réelle s'arrête au consentement OAuth du compte de démonstration :
la décision d'approbation est refusée par l'API avec HTTP 400 `invalid_request`.
Les identifiants du client confidentiel ne sont pas disponibles dans
l'environnement local, ce qui empêche aussi l'exécution du nouveau MCP local
contre les opérations privées réelles.

Les deux blocages sont distincts : le mot de passe du compte utilisateur ne
remplace pas le Basic du client confidentiel. Aucun contournement par un jeton
de switch navigateur ou par l'échange historique n'a été utilisé.

## Périmètre

- Code local : MCP **0.13.0**, Bun **1.3.14**, Windows.
- API interrogée : `https://app.api-magileads.net`.
- Ressource MCP : `https://mcp.magileads.io/mcp`.
- Compte original fourni et vérifié : **777** ; cible autorisée par l'utilisateur
  pour la recette : **4192**.
- La version du code API déployé et son numéro de commit n'ont pas été établis.
- Aucun push ni déploiement MCP réalisé pendant cette recette.

## Changements MCP réalisés

1. Parcours automatique pour HTTP OAuth privé, profil `full`, sans variable
   d'activation. Clés API, stdio et profil public restent hors du switch.
2. `get_active_account` utilisable avec `mcp:read` **ou** `mcp:write` seul.
   Lister les comptes exige toujours read ; sélectionner/revenir exige write.
3. Conservation du contrat privé strict : Basic interne, bearer source en JSON,
   ressource exacte, aucune redirection, pas de `confirm`/`account_revision`
   supplémentaires transmis à ces routes.
4. Échange contextuel avec révision + ressource MCP, validation du binding
   acteur/cible/révision, sans cache ni repli vers l'échange historique.
   Jeton API limité à 300 secondes et endpoint d'échange sur l'origine de l'issuer.
5. Messages distincts pour expiration de la délégation de 60 minutes, cible
   indisponible, droits retirés, révision périmée et ressource incorrecte.
6. Pas de renouvellement automatique, de retry de mutation incertaine ou de
   retour implicite à l'original. Les 401 métier switchés ne demandent pas de
   reconnexion de l'original ; une vraie révocation originale reste traitée.
7. Curseurs masqués dans les logs. Le fichier de test et les fichiers locaux
   d'environnement sont exclus de Git et du contexte Docker.
8. Script `bun run check:switch` : recette authentifiée du **MCP de ce checkout**
   contre l'API réelle, lecture seule par défaut, mutations sur comptes de test
   seulement avec paramètres et flags explicites.

## Vérifications locales

Commandes exécutées :

```shell
bun run typecheck
bun run test:oauth
bun node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --strict --skipLibCheck scripts/check-account-switching.ts
git diff --check
```

Résultat : **96 tests réussis, 0 échec, 2 924 assertions** ; vérification des types
du serveur et du script OK ; contrôle des espaces/diff OK.

Les tests utilisent une API et un issuer locaux simulés. Ils prouvent le
comportement du MCP face à ce contrat, **pas l'implémentation du backend réel**.

| Scénario local | Résultat |
| --- | --- |
| Activation automatique uniquement en HTTP OAuth privé | Conforme |
| Profil public / clés API / stdio sans outils de switch | Conforme au câblage et aux tests des profils concernés |
| Read seul : contexte accessible, mutations interdites | Conforme |
| Write seul : contexte, sélection connue, création et retour sans appel à la liste | Conforme |
| Contrat privé strict, recherche et pagination opaque | Conforme |
| Switch + lecture métier sur la cible, original conservé | Conforme |
| Création du modèle sur la cible via le script complet, puis retour vérifié | Conforme sur API simulée |
| Confirmation manquante/périmée et deux switches concurrents | Refus sans mauvaise écriture |
| Expiration à 60 minutes, nouvelle sélection explicite, nouvelle révision | Conforme sur horloge API simulée |
| Cible indisponible / droits retirés / délégation expirée | Erreur conservant la sélection, retour explicite possible |
| 401 métier switché, invalid_client et indisponibilité | Pas de fausse reconnexion de l'original |
| Vraie révocation originale | Challenge OAuth conservé |
| Refresh / plusieurs instances / grants, utilisateurs et domaines distincts | Isolation et persistance simulées conformes |
| Binding erroné, durée > 300 s, autre origine du token endpoint | Appel métier bloqué |
| Réponse de switch perdue après commit | État incertain explicite, aucun PUT rejoué |
| Script réel en lecture seule / mauvais compte original | Blocage explicite, aucune mutation |

## Vérifications sur les services déployés

| Vérification réelle | Preuve / résultat |
| --- | --- |
| Discovery de l'issuer | HTTP 200, issuer et endpoints publiés cohérents |
| JWKS publics | Préflight public OK |
| Métadonnées MCP aux deux URLs et challenge sans authentification | Préflight public OK, ressource exacte et URL de métadonnées du même domaine |
| Connexion email/mot de passe du compte fourni | `POST /users/authentication` : HTTP 200 |
| Identité web originale | `GET /users/me` : HTTP 200, ID 777 |
| Enregistrement du client de recette public | `POST /oauth/register` : HTTP 201, client créé sans secret confidentiel |
| Démarrage authorization_code + PKCE S256 | `GET /oauth/authorize` : HTTP 302 vers le consentement sur `application.magileads.io` |
| Lecture du consentement avec la session principale | `GET /oauth/authorization-transactions/{id}` : HTTP 200, `state:true`, bonne ressource et scopes read/write |
| Approbation du consentement | **HTTP 400 `invalid_request`**, pas de code d'autorisation obtenu |
| Présence de la protection Basic des routes privées | POST contexte/liste avec corps au format attendu mais sans Basic : HTTP 401 `invalid_client` |
| Autorisation du vrai client confidentiel pour la ressource | **Non vérifiée** : identifiants internes absents localement |
| Switch OAuth 777 → 4192 et modèle réel sur 4192 | **Non exécutés**, ne pas les considérer comme validés |

La vérification de garde Basic ne prouve ni la présence de la migration ni les
permissions du client confidentiel, ni le fonctionnement de la délégation.
Aucun modèle ni campagne réels n'a été créé/envoyé pendant cette recette.
Aucun switch réel entre les comptes 777 et 4192 n'a été effectué.

## Blocage à transmettre à l'équipe API

Sur une transaction fraîche, avec la session web principale du compte **777** :

```http
POST /oauth/authorization-transactions/{transaction_fraiche}
Content-Type: application/json
Accept: application/json
Authorization: Bearer <session web principale, ne pas journaliser>
Origin: https://application.magileads.io

{"decision":"approve"}
```

Réponse obtenue :

```json
{"error":"invalid_request","error_description":"The consent request is invalid."}
```

Le frontend actuellement publié appelle bien cette route avec
`{decision:"approve"}` et `useMainIdentity:true` : le corps et l'identité utilisés
par la recette suivent ce code public. L'absence d'Origin et l'encodage formulaire
ont également été vérifiés ; ils ne réparent pas ce refus.

Reproduction fraîche du **26 octobre à 11:02:55 UTC (14:02:55 à Madagascar)** :
authorization HTTP 302, lecture HTTP 200, approbation HTTP 400. L'expiration
annoncée était **11:12:58 UTC**, donc ce constat n'est pas expliqué par une
transaction déjà expirée. Aucun diagnostic de cause backend précis n'est affirmé :
il faut consulter la validation et les logs API sans exposer de secrets.

Client public de recette : `Magileads MCP integration test 2026-10-26`.
Callback enregistré : `https://mcp.magileads.io/oauth-test/callback` ; la recette
ne suit pas ce callback et devait récupérer le code côté processus local après
vérification du state, puis l'échanger avec PKCE. Aucun code n'a été délivré.
Les identifiants de transaction, codes PKCE et jetons ne figurent pas dans ce rapport.

## Pour lever les blocages

1. Diagnostiquer le refus de consentement ci-dessus et refaire une autorisation
   de démonstration complète, ou fournir par canal local sécurisé un bearer MCP
   valide d'une connexion de démonstration existante.
2. Mettre les **cinq `OAUTH_*` existants** et `MCP_TEST_SUBJECT_TOKEN` à disposition
   dans l'environnement sécurisé local. Le bearer doit viser exactement le domaine
   testé, avec read/write. Aucun secret dans les arguments, logs ou échanges de chat.
3. Confirmer côté API la migration, `oauth:check-readiness`, puis
   `oauth:authorize-mcp-account-switching <client_id> <ressource MCP exacte>` pour
   Magileads et chaque domaine revendeur concerné.
4. Définir `MCP_TEST_EXPECTED_USER_ID=777`, `MCP_TEST_TARGET_USER_ID=4192`, puis
   exécuter `bun run check:switch --allow-switch --allow-create-model`.
   Ce test laisse un modèle de recette nommé explicitement, sans envoi, et vérifie
   le retour à l'original. Il ne rejoue pas une écriture au résultat incertain.
5. Recetter également avec le client final Claude/ChatGPT et un domaine revendeur
   autorisé. Le succès du domaine principal ne prouve pas celui de chaque revendeur.

**Attention au déploiement :** en profil privé OAuth, le contexte est désormais
consulté avant chaque outil, même sur l'original. L'autorisation Basic/client/ressource
doit donc être prête avant le déploiement MCP ; une découverte de domaine réussie
ne suffit pas. Le MCP échoue sans repli plutôt que d'agir sous une autre identité.
