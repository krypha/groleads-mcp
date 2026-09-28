# Publier Magileads dans ChatGPT

Le serveur MCP HTTP existant peut être utilisé dans ChatGPT en ligne. Deux étapes
distinctes : une connexion privée en mode développeur pour valider l'intégration,
puis une soumission du **plugin MCP distant** au répertoire public. Il n'est pas
nécessaire de créer une seconde API, une interface personnalisée ou un plugin
Codex local. Les [instructions OpenAI pour les serveurs MCP distants](https://developers.openai.com/plugins/deploy/submission)
décrivent la soumission « With MCP ».

## 1. Valider la connexion cloud en privé

1. Déployer la version à tester sur l'URL canonique
   `https://mcp.magileads.io/mcp`, avec `MCP_HTTP_AUTH=oauth` (ou `both` si les
   clients existants ont encore besoin des clés API). Définir
   `MCP_TOOL_PROFILE=public` pour le catalogue public : 22 outils métier
   dédiés restent accessibles, les trois outils génériques
   (`list_api_endpoints`, `magileads_get`, `magileads_request`) sont masqués.
   Le profil par défaut `full` conserve les 25 outils pour les intégrations
   privées. Sur une même URL, ce profil s'applique à tous les clients HTTP.
   Garder
   `MCP_ALLOW_API_KEY_QUERY=false` pour éviter les clés dans les URL et les logs.
2. Vérifier `https://mcp.magileads.io/health` puis lancer le préflight public :

   ```bash
   OAUTH_ISSUER=https://app.api-magileads.net \
   OAUTH_MCP_RESOURCE=https://mcp.magileads.io/mcp \
   bun run check:oauth
   ```

3. Dans ChatGPT, activer le mode développeur dans les paramètres de sécurité,
   puis ajouter un plugin MCP avec cette URL HTTPS complète. Autoriser un compte
   Magileads de test et exécuter des outils de lecture, puis une écriture confirmée
   sur des données de test. [Procédure ChatGPT officielle](https://developers.openai.com/plugins/deploy/connect-chatgpt).
4. Tester le consentement OAuth, le renouvellement de session, les comptes
   multiples et les erreurs 401/403/503. Un `tools/list` réussi ne prouve pas
   que les routes métier et le Token Exchange fonctionnent.

Chaque utilisateur se connecte avec **son propre compte Magileads** via OAuth ;
le secret `OAUTH_INTERNAL_CLIENT_SECRET` reste exclusivement côté serveur MCP.
Ne pas saisir de clé API Magileads dans le formulaire OAuth ChatGPT.

## 2. Préparer la fiche publique

Dans l'[OpenAI Platform, portail de soumission](https://developers.openai.com/plugins/deploy/submission),
choisir « Create plugin » → « With MCP » → URL **Universal**
`https://mcp.magileads.io/mcp`. Le serveur est multi-tenant via OAuth, sans URL
distincte par client.

Éléments à fournir par Magileads avant la soumission :

- Identité d'entreprise vérifiée sur l'organisation OpenAI qui publiera le
  plugin, et droit « Apps Management: Write » pour la personne qui soumet.
- Logo officiel, nom et descriptions approuvés, catégorie, site web, URL de
  support, politique de confidentialité et conditions d'utilisation publiques.
  Décrire les données de contacts et campagnes réellement retournées par les
  outils ; exclure les secrets et données personnelles superflues.
- Pays de disponibilité et version de la fiche. Ne pas annoncer une disponibilité
  publique avant approbation **et** publication.
- Compte Magileads de démonstration avec listes, contacts et campagne de test,
  accessible au réviseur sans MFA, SMS, confirmation e-mail ni VPN. Mettre les
  identifiants uniquement dans le champ privé prévu par le portail, jamais dans
  Git ou les logs.
- Le profil public masque les trois outils de passthrough : ils couvrent aussi
  des routes d'administration, de facturation, d'utilisateurs et d'envoi de
  messages. Ce choix réduit le risque de revue, mais **ne garantit pas**
  l'approbation. Les autres 22 outils doivent encore être testés avec un compte
  de démonstration et leurs réponses auditées pour les données personnelles.

Texte de fiche proposé, à faire approuver par Magileads :

- **Nom :** Magileads
- **Description courte :** « Explorez vos contacts, listes et campagnes Magileads
  directement dans ChatGPT. »
- **Description longue :** « Connectez votre compte Magileads pour consulter vos
  listes de contacts, votre pipeline PRM et les statistiques de vos campagnes.
  Vous pouvez aussi préparer un ciblage Google Maps et importer un contact ;
  les actions d'écriture demandent une confirmation explicite. »

Suggestions de prompts de démarrage (adapter selon les outils finalement exposés) :

- « Résume l'état de mes listes de contacts Magileads. »
- « Quelles campagnes sont en cours et comment performent-elles ? »
- « Montre les statuts disponibles dans mon pipeline PRM. »
- « Prépare un ciblage Google Maps pour des restaurants à Lyon. »

## 3. Vérifier le domaine

Quand le portail affiche un jeton de vérification, ajouter ce jeton **exact**
dans le secret de déploiement `OPENAI_APPS_CHALLENGE_TOKEN`, puis redéployer.
Le MCP expose alors uniquement ce jeton, en texte brut, sur :

`https://mcp.magileads.io/.well-known/openai-apps-challenge`

Vérifier la réponse publique (statut 200, corps exactement égal au jeton,
sans JSON, guillemets ni nouvelle ligne) avant de cliquer sur « Verify Domain ».
Sans variable, la route répond 404. Cette variable n'est pas un jeton OAuth,
une clé API ou le secret du client interne ; ne pas les intervertir. Si le proxy
réserve `/.well-known`, autoriser explicitement ce chemin jusqu'au MCP.

## 4. Scan, tests et publication

Dans le portail, renseigner OAuth, scanner les outils et vérifier noms, schémas
et annotations `readOnlyHint`, `destructiveHint`, `openWorldHint`. Le serveur
marque les recherches Google Maps et l'écriture générique ouverte comme
`openWorldHint:true`, les lectures du compte privé comme `false`.

Préparer au moins **cinq cas positifs et trois négatifs**, chacun avec prompt,
comportement attendu et données de démonstration reproductibles. Proposition :

| Type | Prompt/scénario | Résultat attendu |
| --- | --- | --- |
| Positif | « Donne un aperçu de mon compte Magileads » | `get_account_overview`, identité et abonnement du compte démo. |
| Positif | « Liste mes listes de contacts » | `search_contact_lists`, noms et compteurs des listes de démo. |
| Positif | « Montre les contacts de la liste Démo » | `query_contacts`, page bornée aux contacts autorisés. |
| Positif | « Résume la campagne Démo » | `list_campaigns` puis `get_campaign_statistics`, statistiques cohérentes. |
| Positif | « Quels sont mes statuts PRM ? » | `list_prm_statuses`, statuts du compte démo. |
| Négatif | Compte non connecté | Défi OAuth ; aucune donnée de compte. |
| Négatif | Jeton `mcp:read` demandant un outil d'écriture | Refus `403 insufficient_scope`, aucune écriture. |
| Négatif | `add_contact_to_list` sans `confirm:true` | Dry-run uniquement ; aucun contact importé. |

Si l'on veut démontrer une écriture positive, utiliser un contact fictif dans le
compte de démo et indiquer clairement le résultat attendu. Ne jamais tester une
suppression ou un envoi réel sur un compte client. Après le scan et les tests,
soumettre à l'examen d'OpenAI. **L'approbation ne publie pas automatiquement** :
le propriétaire choisit ensuite « Publish ». Le répertoire publié est commun à
ChatGPT et Codex. [Exigences de revue MCP](https://developers.openai.com/plugins/deploy/app-review).

Pour les restrictions de domaines d'un espace de travail ChatGPT, demander à
l'équipe API de vérifier la prise en charge `openid`/`email` et un endpoint
UserInfo retournant `email` et `email_verified: true`. Ce point n'est pas
remplacé par le seul succès du flux OAuth de connexion.
