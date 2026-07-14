### 🕸️ 1. DAG (Directed Acyclic Graph) — Job Dependency Resolution

When it comes into picture:
In Phase 3 (Queue) and Phase 4 (Execution), when we support the needs keyword in workflows:

```
yaml
jobs:
  lint:
    runs-on: ubuntu-latest
  test:
    needs: lint
    runs-on: ubuntu-latest
  deploy:
    needs: [lint, test]
    runs-on: ubuntu-latest
```

#### The Concept:
- Jobs cannot simply run in a flat, linear sequence. They form a Directed Acyclic Graph (DAG):

- Nodes: The jobs (e.g., lint, test, deploy).
    - Edges: The dependency relationships (test pointing to lint).
    - Acyclic: There must be no cycles (e.g. if lint needs test, and test needs lint, that's a cycle, causing an infinite deadlock).

```
[ lint ] ──▶ [ test ]
     │            │
     ▼            ▼
      \          /
       ▼        ▼
       [ deploy ]
```

#### How we will implement it:

Cycle Detection: When parsing the YAML, we will build a dependency graph of the jobs. We will run a Topological Sort or a Depth-First Search (DFS) to detect if the user accidentally introduced a dependency loop. If a cycle is detected, we reject the run immediately.
Execution Coordination:
Initially, we only enqueue jobs with zero dependencies (e.g. lint).
When the runner completes lint, the server checks the DAG to see which jobs have all their dependencies satisfied, and then enqueues test.

---

### 🌳 2. AST (Abstract Syntax Tree) — Expression & Conditional Evaluation
When it comes into picture:
In Phase 3 (YAML Parsing) and Phase 4 (Step Execution), when we evaluate conditional expressions (if:) and interpolations (${{ ... }}):

```
yaml
if: success() && github.ref == 'refs/heads/main'
run: echo "Deploying to ${{ env.APP_NAME }}"
```

The Concept:
A computer cannot understand a string like success() && github.ref == 'refs/heads/main' directly. To evaluate this:

- Lexer/Tokenizer: Breaks the string into tokens: [Function(success), Operator(&&), Variable(github.ref), Operator(==), String(refs/heads/main)].
- Parser (AST): Arranges these tokens into an Abstract Syntax Tree (AST), which represents the logical structure of the expression:

```
&& (AND Node)
           /            \
     success()        == (EQUAL Node)
                     /               \
                github.ref      'refs/heads/main'
```

#### How we will implement it:
- For a 60% MVP clone, we will use a lightweight expression resolver (using regular expressions and a simple token replacement engine) rather than writing a full lexer/parser from scratch, to avoid adding hundreds of lines of compiler code.
- However, the underlying execution logic still behaves exactly like an AST evaluator, recursively solving leaf nodes (like replacing ${{ secrets.KEY }}) before evaluating parent boolean operators.