import { Observable } from 'rxjs/Observable'
import { map } from 'rxjs/operators/map'
import { gql, queryGraphQL } from '../backend/graphql'
import { AbsoluteRepoFilePosition, makeRepoURI } from '../repo'
import { memoizeObservable } from '../util/memoize'

export const fetchBlameFile = memoizeObservable(
    (ctx: AbsoluteRepoFilePosition): Observable<GQL.IHunk[] | null> =>
        queryGraphQL(
            gql`
                query BlameFile(
                    $repoPath: String
                    $commitID: String
                    $filePath: String
                    $startLine: Int
                    $endLine: Int
                ) {
                    repository(uri: $repoPath) {
                        commit(rev: $commitID) {
                            file(path: $filePath) {
                                blame(startLine: $startLine, endLine: $endLine) {
                                    startLine
                                    endLine
                                    startByte
                                    endByte
                                    rev
                                    author {
                                        person {
                                            name
                                            email
                                            gravatarHash
                                        }
                                        date
                                    }
                                    message
                                }
                            }
                        }
                    }
                }
            `,
            {
                repoPath: ctx.repoPath,
                commitID: ctx.commitID,
                filePath: ctx.filePath,
                startLine: ctx.position.line,
                endLine: ctx.position.line,
            }
        ).pipe(
            map(result => {
                if (
                    !result.data ||
                    !result.data.repository ||
                    !result.data.repository.commit ||
                    !result.data.repository.commit.file ||
                    !result.data.repository.commit.file.blame
                ) {
                    console.error('unexpected BlameFile response:', result)
                    return null
                }
                return result.data.repository.commit.file.blame
            })
        ),
    makeRepoURI
)
