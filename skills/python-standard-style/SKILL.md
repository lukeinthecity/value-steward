---
name: python-standard-style
description: Enforces PEP 8 Python coding standards. Use when writing, refactoring, or reviewing Python code to ensure consistent naming conventions, 4-space indentation, max 100-character line length, and proper import organization.
---

# Python Standard Style (PEP 8)

This skill provides guidance and rules for writing professional, standardized Python code.

## Core Mandates

1. **Indentation**: Use exactly 4 spaces per indentation level. Never use tabs.
2. **Line Length**: Limit all lines to a maximum of 100 characters.
3. **Blank Lines**: 
    - Surround top-level function and class definitions with two blank lines.
    - Method definitions inside a class are surrounded by a single blank line.
4. **Imports**:
    - Imports should be on separate lines.
    - Order: Standard library, related third-party, local application/library imports.
    - Use absolute imports over relative imports.
5. **Naming Conventions**:
    - Classes: `CapWords` (PascalCase).
    - Functions/Variables/Methods: `lowercase_with_underscores` (snake_case).
    - Constants: `UPPERCASE_WITH_UNDERSCORES`.
    - Protected members: `_leading_underscore`.
    - Private members: `__double_leading_underscore`.
6. **Strings**: Use double quotes `"` for most strings unless single quotes `'` are necessary to avoid escaping.
7. **Whitespace**: Avoid extraneous whitespace inside parentheses, brackets, or before commas and colons.

## Workflow

1. **Analyze**: Before writing or editing, check existing file style.
2. **Apply**: Implement logic using the rules above.
3. **Verify**: Run `ruff check .` or `flake8` if available in the project to confirm compliance.

## Detailed Reference

For a comprehensive list of rules and examples, see [references/pep8_rules.md](references/pep8_rules.md).
