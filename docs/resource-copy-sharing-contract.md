# Copies, partages et sélection globale — intégration MCP 0.14.0

## Ce qui est ajouté côté MCP

Six outils dédiés sont disponibles dans les profils `full` et `public` :
`list_copyable_resources`, `copy_resources_to_user`, `share_resource`,
`share_prm_contacts`, `query_all_contacts`, `copy_contacts_across_lists`.
Les écritures restent locales sans `confirm:true`. En HTTP OAuth privé,
la confirmation exige aussi la révision courante du compte actif.

Le contrat OAuth existant de **249 opérations reste inchangé**. Les outils
réutilisent les routes déjà autorisées, avec leur scope explicite. Aucun endpoint
d'administration, DELETE, PATCH ou annuaire global d'utilisateurs n'est ajouté.

## Routes utilisées : à vérifier côté API

| Opération | Méthode / route | Scope |
| --- | --- | --- |
| Catalogue listes | `GET /contact-lists/names` | `mcp:read` |
| Catalogue modèles | `GET /models/email`, `/models/linkedin/invitation`, `/models/linkedin/message`, `/models/sms`, `/models/smv` | `mcp:read` |
| Catalogue workflows | `GET /workflows` | `mcp:read` |
| Copie liste vers utilisateur | `POST /contact-lists/{id}/copy/to/{user_id}` | `mcp:write` |
| Copie modèle vers utilisateur | `POST /models/{type}/{id}/copy/to/{user_id}` — cinq familles ci-dessus | `mcp:write` |
| Copie workflow vers utilisateur | `POST /workflows/{id}/copy/to/{user_id}` avec `{with_models:true}` par défaut | `mcp:write` |
| Lecture du partage complet | `GET /contact-lists/{id}`, `GET /models/{type}/{id}`, `GET /workflows/{id}`, `GET /data-fields/{id}` | `mcp:read` |
| Modification du partage | `PUT` sur ces mêmes profils, sauf SMV : `POST /models/smv/{id}` | `mcp:write` |
| Partage PRM explicite | `POST /prm/sharings` | `mcp:write` |
| Identité active | `GET /users/me` | `mcp:read` |
| Résolution des champs | `GET /data-fields` | `mcp:read` |
| Recherche globale | `POST /contact-lists/contacts/search` | `mcp:read` |
| Pagination globale | `GET /contact-lists/contacts/search/{search_id}/page/{page}` | `mcp:read` |
| Destination de copie visible | `GET /contact-lists/{id}` | `mcp:read` |
| Copie de sélection globale | `POST /contact-lists/contacts/copy/{contact_list_id_destination}` | `mcp:write` |

Le Token Exchange demande **lecture + écriture** pour `share_resource` et
`copy_contacts_across_lists`, et seulement écriture pour `copy_resources_to_user`
et `share_prm_contacts`. Les deux outils de catalogue/recherche utilisent seulement
la lecture, même quand une recherche utilise POST.

### Format des partages

Le MCP lit `sharing` dans `model_profile`, `workflow_profile`,
`contact_list_profile` ou `data_field_profile`, puis envoie :

```json
{
  "sharing": [{
    "sharing_type_to": "User",
    "read_permission": true,
    "write_permission": false,
    "delete_permission": false,
    "ids_list": [4192],
    "name": "Partage demandé"
  }]
}
```

Les valeurs `Team` et `Organization` sont également prises en charge. Les anciennes
règles, y compris `ResellerCustomers`, sont conservées. Les IDs peuvent être lus
depuis `ids_list` ou `sharing_targets:[{id,name}]`. Un ACL masqué (`sharing:null`),
incomplet ou non administrable est refusé avant modification. Le retrait ne retire
que les destinations explicites choisies ; un accès hérité peut donc subsister.

Pour le PRM, le corps est `{sharing:{...règle,contact_ids:[...]}}`.
Pour SMV, l'outil utilise le multipart décrit par le Swagger et le même encodage
que le frontend Magileads (`ModelsApi.editSMV`) : champ `sharing` contenant les
chaînes JSON des règles, séparées par des virgules ; champ vide pour retirer la
dernière règle. Aucun autre champ ni fichier audio n'est envoyé. Ce format est
testé sur l'API simulée ; la validation réelle exige une fixture SMV disponible.
Ne pas interpréter cet outil comme un support d'upload audio.

### Sélection globale

La recherche envoie `{options:{per_page,filter}}` ; `filter.field_name` est l'ID
numérique du champ sous forme de chaîne. Le MCP compare l'aperçu et le recomptage
(compte actif, filtre résolu, cible, total et nombre correspondant), puis envoie
une seule requête :

```json
{
  "contacts_selection": {
    "filter": {"mode":"and","values":[{"field_name":"3","type":"contains","value":"Example"}]},
    "contact_ids": [],
    "excluded_contact_ids": [],
    "reverse_selection": false
  }
}
```

Le MCP ne relance pas automatiquement une copie en erreur. En lot, il arrête les
copies suivantes et rend les IDs acceptés, en échec/incertains et non tentés.
Un 401 après une copie acceptée reste dans ce résultat partiel afin de conserver
ces informations ; le prochain appel indépendant suit l'authentification normale.

## Évolutions API nécessaires pour couvrir davantage

1. **Destinataires par nom.** Fournir un annuaire métier minimal et paginé des
   utilisateurs/équipes/organisations que le compte actif est autorisé à recevoir
   en partage ou copie, avec `id`, type et nom. Ce n'est pas une ouverture de
   `GET /users/list` ou des routes admin. Aujourd'hui l'appelant fournit les IDs ;
   `get_account_overview` expose les IDs de ses propres équipes/organisations et
   le profil privé OAuth dispose de `list_switchable_accounts`.
2. **Familles hors contrat.** Fournir une correspondance approuvée
   méthode/route/scope/payload pour les signatures, fichiers, intégrations,
   tags, pools, URLs courtes, blacklists, agents IA et rapports partageables.
   Plusieurs routes existent dans le Swagger mais sont absentes du contrat OAuth.
   Exemples : `PUT /email-signatures/{email_signature_id}`,
   `POST /files/{file_id}`, `PUT /integrations/email/mass-mailing/{email_account_id}`,
   `PUT /integrations/linkedin/{linkedin_account_id}`, `PUT /tags/{tag_id}`,
   `PUT /pools/{pool_id}`, `PUT /urls-shortener/{shortened_url_id}`.
   Le MCP pourra ensuite ajouter les outils adaptés sans exposer un passthrough admin.
   Les fichiers demandent en plus un contrat de transfert/binaire explicite.
3. **Campagnes.** Confirmer les opérations de copie/partage d'une *programmation*
   distinctes des workflows. Aujourd'hui copier un workflow copie un scénario
   (et ses modèles), sans cloner une campagne planifiée ni démarrer un envoi.
4. **Concurrence ACL.** Ajouter une révision ACL et une mise à jour conditionnelle,
   ou une opération atomique d'ajout/retrait de destinataires. La lecture-fusion-
   écriture actuelle préserve les règles lues mais ne verrouille pas un changement
   concurrent effectué entre les deux requêtes.
5. **Sélection figée.** Fournir un jeton d'aperçu lié au compte et aux IDs sélectionnés,
   consommable par une copie avec compteur attendu, ou vérifier atomiquement le
   compteur/révision côté API. Le recomptage MCP limite les erreurs mais le filtre
   peut encore changer entre recomptage et exécution. Une clé d'idempotence côté
   API permettrait aussi de résoudre un résultat réseau incertain sans recopie.

## Validation

`bun run test:oauth` couvre les routes, unions de scopes, aperçus sans appel API,
conservation des ACL, refus des ACL masqués, résultats partiels, pagination et
empreintes de sélection. `scripts/check-resource-operations.ts` est une recette
réelle via le **MCP stdio local** : lecture par défaut, écritures seulement sur
comptes de démonstration explicitement autorisés. Elle ne valide pas le consentement
ni le Token Exchange OAuth du serveur déployé. Après déploiement, rafraîchir le
catalogue du client et refaire une lecture, un partage et une copie confirmés via OAuth.
