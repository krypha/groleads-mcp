# Recette copie / partage / filtre global — 26 octobre 2026

Version locale : MCP 0.14.0, transport **stdio**, SDK MCP officiel et API réelle
`https://app.api-magileads.net`. Connexion par les identifiants de démonstration
fournis localement, jamais enregistrés dans ce document ni dans le dépôt.
Compte source vérifié : **777** ; destinataire autorisé : **4192**.

## Résultats réels

| Vérification | Résultat |
| --- | --- |
| Identité du compte source | 777 confirmé par `get_account_overview` |
| Catalogue compact et pagination locale | Listes, modèles email, workflows : OK ; catalogue SMV vide |
| Filtre global sans correspondance | Zéro résultat confirmé |
| Création modèle QA | Modèle **45912**, aucun message envoyé |
| Partage du modèle à 4192, relecture, retrait et relecture | OK |
| Copie du modèle vers 4192 | API acceptée, nouveau modèle **45913** |
| Partage d'une liste QA à 4192, relecture, retrait et relecture | OK sur la liste **74185** |
| Import d'un contact synthétique dans chacune de deux listes | Un contact dans **74183**, un dans **74184**, adresses `example.invalid` |
| Filtre global sur les deux contacts et lecture de la page 2 | Exactement deux correspondances ; pagination fonctionnelle |
| Copie globale vers la destination QA | **74185** contient finalement deux contacts ; tâche `Copy`, `Completed`, 100 % |

La copie globale est asynchrone. Le premier contrôle après acceptation observait
encore zéro contact ; une lecture ultérieure a montré `InProgress`, puis `Completed`.
La copie n'a pas été répétée. Le MCP renvoie maintenant explicitement un `next_check`
vers `get_contact_list_status` et ne présente pas l'acceptation comme la fin du travail.

Le nom des fixtures est `MCP QA 2026-10-26T14-36-40-188Z`, suivi du rôle pour les
listes. Elles sont conservées comme données de démonstration identifiables : le
contrat MCP n'expose pas DELETE. Les deux partages temporaires ont été retirés.

## Tests automatisés et limites

Vérification finale : **115 tests réussis, zéro échec**, vérification TypeScript
du serveur et du script de recette réussie.

La suite locale vérifie aussi les sept familles de copie, les huit familles de
partage, le payload PRM, les unions lecture/écriture, les aperçus locaux, les ACL
préservés/masqués, les erreurs au milieu d'un lot (dont 401), les destinations
globales, les curseurs, les changements de filtre/compte/compteur et les entrées
dupliquées ou trop grandes. Ces cas utilisent une API simulée.

Cette recette **ne valide pas le serveur HTTP OAuth déployé**, son Token Exchange
ou son consentement. Après push/déploiement et rafraîchissement du catalogue,
refaire une lecture puis un partage/copie confirmés avec le client OAuth.
Les copies de workflows/autres canaux, les partages équipes/organisations/PRM et
la mise à jour de partage SMV n'ont pas été exécutés sur l'API réelle pendant cette
recette. Aucun modèle SMV n'était disponible sur le compte de test. Le multipart
de métadonnées suit désormais le format du frontend Magileads, avec tests de
transport simulés ; son exécution réelle reste à valider sur une fixture SMV.

Les extensions hors contrat et les garanties atomiques manquantes sont décrites
dans [le contrat d'intégration](resource-copy-sharing-contract.md).
