//! Fixed merge-task quality gate, not a Python runtime or a general code judge.
//!
//! Model text is parsed into a deliberately small AST and interpreted as bounded
//! integers and lists. There are no host calls, imports, attribute lookup, object
//! introspection, filesystem, process or network capabilities. Unsupported syntax
//! fails closed. Text/ASTs stay in memory and are never included in diagnostics.
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

const MAX_SOURCE: usize = 16 * 1024;
const MAX_LINES: usize = 256;
const MAX_TOKENS: usize = 4096;
const MAX_DEPTH: usize = 24;
const MAX_NAMES: usize = 64;
const MAX_LIST: usize = 1024;
const MAX_INTEGER: i64 = 1_000_000_000;
const TOTAL_TIMEOUT: Duration = Duration::from_millis(250);
pub(super) const VERSION: &str = "request-aba-code-v2";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum QualityError {
    Unsupported,
    Bounds,
    Timeout,
    Incorrect,
    InputMutation,
    NonLinear,
    Contract,
}
impl QualityError {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Unsupported => "编程输出使用了质量检查不支持的语法",
            Self::Bounds => "编程输出超过质量检查的大小、嵌套或整数限制",
            Self::Timeout => "编程质量检查超过时间限制",
            Self::Incorrect => "merge_sorted 未通过固定正确性用例",
            Self::InputMutation => "merge_sorted 修改了输入列表",
            Self::NonLinear => "merge_sorted 超过按输入长度限定的工作预算",
            Self::Contract => "编程输出缺少指定函数、短文档字符串或两个有效断言",
        }
    }
}
type Checked<T> = Result<T, QualityError>;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Name(String),
    Integer(i64),
    String,
    Symbol(&'static str),
    Newline,
    Indent,
    Dedent,
    End,
}

fn lex(source: &str, deadline: Instant) -> Checked<Vec<Token>> {
    if source.len() > MAX_SOURCE || source.lines().count() > MAX_LINES {
        return Err(QualityError::Bounds);
    }
    if source.contains('\0') {
        return Err(QualityError::Unsupported);
    }
    let source = source.trim();
    let source = if source.starts_with("```python\n") && source.ends_with("```") {
        source
            .strip_prefix("```python\n")
            .unwrap()
            .strip_suffix("```")
            .unwrap()
    } else {
        source
    };
    let bytes = source.as_bytes();
    let mut index = 0;
    let mut levels = vec![0usize];
    let mut brackets = Vec::new();
    let mut beginning = true;
    let mut out = Vec::new();
    while index < bytes.len() {
        if out.len() >= MAX_TOKENS {
            return Err(QualityError::Bounds);
        }
        if Instant::now() > deadline {
            return Err(QualityError::Timeout);
        }
        if beginning && brackets.is_empty() {
            let start = index;
            while bytes.get(index) == Some(&b' ') {
                index += 1;
            }
            let indent = index - start;
            if matches!(bytes.get(index), None | Some(b'\n' | b'\r' | b'#')) {
                // Empty/comment lines do not change Python indentation.
            } else {
                if indent > 96 {
                    return Err(QualityError::Bounds);
                }
                let current = *levels.last().unwrap();
                if indent > current {
                    levels.push(indent);
                    out.push(Token::Indent);
                }
                while indent < *levels.last().unwrap() {
                    levels.pop();
                    out.push(Token::Dedent);
                }
                if indent != *levels.last().unwrap() || levels.len() > MAX_DEPTH {
                    return Err(QualityError::Bounds);
                }
            }
            beginning = false;
        } else if beginning {
            // Inside brackets Python ignores physical-line indentation. Mark
            // that line consumed before its closing bracket resumes top-level
            // lexing on the same line.
            beginning = false;
        }
        let Some(byte) = bytes.get(index).copied() else {
            break;
        };
        match byte {
            b' ' => index += 1,
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => index += 1,
            b'\n' => {
                index += 1;
                beginning = true;
                if brackets.is_empty() && !matches!(out.last(), None | Some(Token::Newline)) {
                    out.push(Token::Newline);
                }
            }
            b'#' => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let start = index;
                index += 1;
                while bytes
                    .get(index)
                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
                {
                    index += 1;
                }
                let name = &source[start..index];
                if name.len() > 32 || name.contains("__") {
                    return Err(QualityError::Unsupported);
                }
                out.push(Token::Name(name.into()));
            }
            b'0'..=b'9' => {
                let start = index;
                while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                    index += 1;
                }
                if index - start > 10 {
                    return Err(QualityError::Bounds);
                }
                let value = source[start..index]
                    .parse::<i64>()
                    .map_err(|_| QualityError::Bounds)?;
                if index - start > 1 && bytes[start] == b'0' && value != 0 {
                    return Err(QualityError::Unsupported);
                }
                if value > MAX_INTEGER {
                    return Err(QualityError::Bounds);
                }
                out.push(Token::Integer(value));
            }
            b'\'' | b'"' => {
                let quote = byte;
                let triple = bytes.get(index..index + 3) == Some(&[quote, quote, quote]);
                index += if triple { 3 } else { 1 };
                let start = index;
                loop {
                    if index >= bytes.len() || index - start > 512 {
                        return Err(QualityError::Contract);
                    }
                    if bytes[index] == b'\\' {
                        index += 2;
                        continue;
                    }
                    if triple && bytes.get(index..index + 3) == Some(&[quote, quote, quote]) {
                        index += 3;
                        break;
                    }
                    if !triple && bytes[index] == quote {
                        index += 1;
                        break;
                    }
                    if !triple && bytes[index] == b'\n' {
                        return Err(QualityError::Unsupported);
                    }
                    index += 1;
                }
                out.push(Token::String);
            }
            b'(' | b'[' => {
                brackets.push(byte);
                if brackets.len() > MAX_DEPTH {
                    return Err(QualityError::Bounds);
                }
                out.push(Token::Symbol(if byte == b'(' { "(" } else { "[" }));
                index += 1;
            }
            b')' | b']' => {
                if brackets.pop() != Some(if byte == b')' { b'(' } else { b'[' }) {
                    return Err(QualityError::Unsupported);
                }
                out.push(Token::Symbol(if byte == b')' { ")" } else { "]" }));
                index += 1;
            }
            _ => {
                let two = bytes.get(index..index + 2);
                let symbol = match two {
                    Some(b"<=") => "<=",
                    Some(b">=") => ">=",
                    Some(b"==") => "==",
                    Some(b"!=") => "!=",
                    Some(b"+=") => "+=",
                    Some(b"-=") => "-=",
                    _ => match byte {
                        b'+' => "+",
                        b'-' => "-",
                        b'<' => "<",
                        b'>' => ">",
                        b'=' => "=",
                        b':' => ":",
                        b',' => ",",
                        b'.' => ".",
                        b';' => ";",
                        _ => return Err(QualityError::Unsupported),
                    },
                };
                index += symbol.len();
                out.push(Token::Symbol(symbol));
            }
        }
    }
    if !brackets.is_empty() {
        return Err(QualityError::Unsupported);
    }
    if !matches!(out.last(), Some(Token::Newline)) {
        out.push(Token::Newline);
    }
    while levels.len() > 1 {
        levels.pop();
        out.push(Token::Dedent);
    }
    out.push(Token::End);
    if out.len() > MAX_TOKENS {
        return Err(QualityError::Bounds);
    }
    Ok(out)
}

#[derive(Clone, Debug)]
enum Expr {
    Integer(i64),
    Bool(bool),
    Name(String),
    List(Vec<Expr>),
    Unary(&'static str, Box<Expr>),
    Binary(&'static str, Box<Expr>, Box<Expr>),
    Index(Box<Expr>, Box<Expr>),
    Slice(Box<Expr>, Option<Box<Expr>>, Option<Box<Expr>>),
    Len(Box<Expr>),
    Range(Box<Expr>),
    Merge(Box<Expr>, Box<Expr>),
}
#[derive(Clone, Debug)]
enum Stmt {
    Doc,
    Assign(Vec<String>, Expr),
    TupleAssign(Vec<String>, Vec<Expr>),
    Augment(String, &'static str, Expr),
    Append(String, Expr),
    Extend(String, Expr),
    Return(Expr),
    If(Expr, Vec<Stmt>, Vec<Stmt>),
    While(Expr, Vec<Stmt>),
    For(String, Expr, Vec<Stmt>),
    Pass,
}
struct Program {
    body: Vec<Stmt>,
    assertions: Vec<Expr>,
}
struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    deadline: Instant,
}
impl Parser {
    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::End)
    }
    fn eat(&mut self, token: &Token) -> bool {
        if self.peek() == token {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn symbol(&mut self, token: &'static str) -> bool {
        self.eat(&Token::Symbol(token))
    }
    fn word(&mut self, token: &str) -> bool {
        self.eat(&Token::Name(token.into()))
    }
    fn require(&mut self, token: Token) -> Checked<()> {
        if self.eat(&token) {
            Ok(())
        } else {
            Err(QualityError::Unsupported)
        }
    }
    fn name(&mut self) -> Checked<String> {
        let Token::Name(name) = self.peek().clone() else {
            return Err(QualityError::Unsupported);
        };
        if [
            "False",
            "None",
            "True",
            "and",
            "as",
            "assert",
            "async",
            "await",
            "break",
            "class",
            "continue",
            "def",
            "del",
            "elif",
            "else",
            "except",
            "finally",
            "for",
            "from",
            "global",
            "if",
            "import",
            "in",
            "is",
            "lambda",
            "nonlocal",
            "not",
            "or",
            "pass",
            "raise",
            "return",
            "try",
            "while",
            "with",
            "yield",
            "exec",
            "eval",
            "len",
            "range",
            "merge_sorted",
        ]
        .contains(&name.as_str())
        {
            return Err(QualityError::Unsupported);
        }
        self.pos += 1;
        Ok(name)
    }
    fn program(mut self) -> Checked<Program> {
        while self.eat(&Token::Newline) {}
        self.require(Token::Name("def".into()))?;
        self.require(Token::Name("merge_sorted".into()))?;
        for token in [
            Token::Symbol("("),
            Token::Name("a".into()),
            Token::Symbol(","),
            Token::Name("b".into()),
            Token::Symbol(")"),
            Token::Symbol(":"),
        ] {
            self.require(token)?;
        }
        let body = self.suite(0)?;
        if !matches!(body.first(), Some(Stmt::Doc))
            || body
                .iter()
                .skip(1)
                .any(|statement| matches!(statement, Stmt::Doc))
        {
            return Err(QualityError::Contract);
        }
        let mut assertions = Vec::new();
        while self.eat(&Token::Newline) {}
        while self.word("assert") {
            let assertion = self.expr(0, 0)?;
            // Exactly two simple, meaningful calls. General top-level code and
            // tautologies such as `assert True` have no place in this contract.
            if !matches!(&assertion, Expr::Binary("==", left, right) if matches!(left.as_ref(), Expr::Merge(_, _)) && matches!(right.as_ref(), Expr::List(_)))
            {
                return Err(QualityError::Contract);
            }
            assertions.push(assertion);
            if self.symbol(";") {
                continue;
            }
            self.require(Token::Newline)?;
            while self.eat(&Token::Newline) {}
        }
        self.require(Token::End)?;
        if assertions.len() != 2 {
            return Err(QualityError::Contract);
        }
        Ok(Program { body, assertions })
    }
    fn suite(&mut self, depth: usize) -> Checked<Vec<Stmt>> {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        if !self.eat(&Token::Newline) {
            return self.simple_line(depth + 1);
        }
        while self.eat(&Token::Newline) {}
        self.require(Token::Indent)?;
        let mut statements = Vec::new();
        while !matches!(self.peek(), Token::Dedent | Token::End) {
            if self.eat(&Token::Newline) {
                continue;
            }
            statements.extend(self.statement(depth + 1)?);
        }
        self.require(Token::Dedent)?;
        if statements.is_empty() {
            return Err(QualityError::Unsupported);
        }
        Ok(statements)
    }
    fn statement(&mut self, depth: usize) -> Checked<Vec<Stmt>> {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        if Instant::now() > self.deadline {
            return Err(QualityError::Timeout);
        }
        if self.word("if") {
            return Ok(vec![self.if_statement(depth)?]);
        }
        if self.word("while") {
            let condition = self.expr(0, 0)?;
            self.require(Token::Symbol(":"))?;
            return Ok(vec![Stmt::While(condition, self.suite(depth)?)]);
        }
        if self.word("for") {
            let variable = self.name()?;
            self.require(Token::Name("in".into()))?;
            let values = self.expr(0, 0)?;
            self.require(Token::Symbol(":"))?;
            return Ok(vec![Stmt::For(variable, values, self.suite(depth)?)]);
        }
        self.simple_line(depth)
    }
    fn if_statement(&mut self, depth: usize) -> Checked<Stmt> {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        let condition = self.expr(0, 0)?;
        self.require(Token::Symbol(":"))?;
        let yes = self.suite(depth)?;
        let no = if self.word("elif") {
            vec![self.if_statement(depth + 1)?]
        } else if self.word("else") {
            self.require(Token::Symbol(":"))?;
            self.suite(depth)?
        } else {
            vec![]
        };
        Ok(Stmt::If(condition, yes, no))
    }
    fn simple_line(&mut self, depth: usize) -> Checked<Vec<Stmt>> {
        let mut statements = Vec::new();
        loop {
            statements.push(self.simple(depth)?);
            if !self.symbol(";") || matches!(self.peek(), Token::Newline) {
                break;
            }
        }
        self.require(Token::Newline)?;
        Ok(statements)
    }
    fn simple(&mut self, _depth: usize) -> Checked<Stmt> {
        if self.eat(&Token::String) {
            return Ok(Stmt::Doc);
        }
        if self.word("return") {
            return Ok(Stmt::Return(self.expr(0, 0)?));
        }
        if self.word("pass") {
            return Ok(Stmt::Pass);
        }
        let name = self.name()?;
        if self.symbol(",") {
            let mut names = vec![name];
            loop {
                names.push(self.name()?);
                if !self.symbol(",") {
                    break;
                }
            }
            if names.len() > MAX_NAMES {
                return Err(QualityError::Bounds);
            }
            self.require(Token::Symbol("="))?;
            let mut values = vec![self.expr(0, 0)?];
            while self.symbol(",") {
                values.push(self.expr(0, 0)?);
            }
            if names.len() != values.len() {
                return Err(QualityError::Unsupported);
            }
            return Ok(Stmt::TupleAssign(names, values));
        }
        if self.symbol(".") {
            let method = if self.word("append") {
                "append"
            } else if self.word("extend") {
                "extend"
            } else {
                return Err(QualityError::Unsupported);
            };
            self.require(Token::Symbol("("))?;
            let argument = self.expr(0, 0)?;
            self.require(Token::Symbol(")"))?;
            return Ok(if method == "append" {
                Stmt::Append(name, argument)
            } else {
                Stmt::Extend(name, argument)
            });
        }
        for operator in ["+=", "-="] {
            if self.symbol(operator) {
                return Ok(Stmt::Augment(name, operator, self.expr(0, 0)?));
            }
        }
        self.require(Token::Symbol("="))?;
        let mut targets = vec![name];
        while matches!(self.peek(), Token::Name(_))
            && self.tokens.get(self.pos + 1) == Some(&Token::Symbol("="))
        {
            targets.push(self.name()?);
            self.pos += 1;
        }
        Ok(Stmt::Assign(targets, self.expr(0, 0)?))
    }
    fn expr(&mut self, minimum: u8, depth: usize) -> Checked<Expr> {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        let mut left = if self.symbol("-") {
            Expr::Unary("-", Box::new(self.expr(6, depth + 1)?))
        } else if self.word("not") {
            Expr::Unary("not", Box::new(self.expr(3, depth + 1)?))
        } else {
            self.atom(depth + 1)?
        };
        loop {
            let (operator, precedence) = match self.peek() {
                Token::Name(value) if value == "or" => ("or", 1),
                Token::Name(value) if value == "and" => ("and", 2),
                Token::Symbol(operator @ ("==" | "!=" | "<" | "<=" | ">" | ">=")) => (*operator, 3),
                Token::Symbol(operator @ ("+" | "-")) => (*operator, 4),
                _ => break,
            };
            if precedence < minimum {
                break;
            }
            self.pos += 1;
            let right = self.expr(precedence + 1, depth + 1)?;
            left = Expr::Binary(operator, Box::new(left), Box::new(right));
        }
        Ok(left)
    }
    fn atom(&mut self, depth: usize) -> Checked<Expr> {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        let mut expression = match self.peek().clone() {
            Token::Integer(value) => {
                self.pos += 1;
                Expr::Integer(value)
            }
            Token::Name(name) if name == "True" || name == "False" => {
                self.pos += 1;
                Expr::Bool(name == "True")
            }
            Token::Name(name) if ["len", "range", "merge_sorted"].contains(&name.as_str()) => {
                self.pos += 1;
                self.require(Token::Symbol("("))?;
                let first = self.expr(0, depth + 1)?;
                if name == "merge_sorted" {
                    self.require(Token::Symbol(","))?;
                    let second = self.expr(0, depth + 1)?;
                    self.require(Token::Symbol(")"))?;
                    Expr::Merge(Box::new(first), Box::new(second))
                } else {
                    self.require(Token::Symbol(")"))?;
                    if name == "len" {
                        Expr::Len(Box::new(first))
                    } else {
                        Expr::Range(Box::new(first))
                    }
                }
            }
            Token::Name(_) => Expr::Name(self.name()?),
            Token::Symbol("(") => {
                self.pos += 1;
                let value = self.expr(0, depth + 1)?;
                self.require(Token::Symbol(")"))?;
                value
            }
            Token::Symbol("[") => {
                self.pos += 1;
                let mut values = Vec::new();
                if !self.symbol("]") {
                    loop {
                        values.push(self.expr(0, depth + 1)?);
                        if self.symbol("]") {
                            break;
                        }
                        self.require(Token::Symbol(","))?;
                        if self.symbol("]") {
                            break;
                        }
                    }
                }
                Expr::List(values)
            }
            _ => return Err(QualityError::Unsupported),
        };
        while self.symbol("[") {
            let start = if self.symbol(":") {
                None
            } else {
                let value = self.expr(0, depth + 1)?;
                if self.symbol("]") {
                    expression = Expr::Index(Box::new(expression), Box::new(value));
                    continue;
                }
                self.require(Token::Symbol(":"))?;
                Some(Box::new(value))
            };
            let end = if self.symbol("]") {
                None
            } else {
                let value = self.expr(0, depth + 1)?;
                self.require(Token::Symbol("]"))?;
                Some(Box::new(value))
            };
            expression = Expr::Slice(Box::new(expression), start, end);
        }
        Ok(expression)
    }
}

#[derive(Clone, Debug)]
enum Datum {
    Integer(i64),
    Bool(bool),
    List(Rc<RefCell<Vec<i64>>>),
}
impl Datum {
    fn integer(self) -> Checked<i64> {
        if let Self::Integer(value) = self {
            Ok(value)
        } else {
            Err(QualityError::Unsupported)
        }
    }
    fn list(self) -> Checked<Rc<RefCell<Vec<i64>>>> {
        if let Self::List(value) = self {
            Ok(value)
        } else {
            Err(QualityError::Unsupported)
        }
    }
    fn truth(&self) -> bool {
        match self {
            Self::Integer(value) => *value != 0,
            Self::Bool(value) => *value,
            Self::List(value) => !value.borrow().is_empty(),
        }
    }
}
fn list(values: Vec<i64>) -> Checked<Datum> {
    if values.len() > MAX_LIST {
        return Err(QualityError::Bounds);
    }
    Ok(Datum::List(Rc::new(RefCell::new(values))))
}
struct Budget {
    left: usize,
    deadline: Instant,
    ticks: usize,
}
impl Budget {
    fn spend(&mut self, amount: usize) -> Checked<()> {
        self.left = self
            .left
            .checked_sub(amount)
            .ok_or(QualityError::NonLinear)?;
        self.ticks = self.ticks.saturating_add(amount);
        if self.ticks >= 128 {
            self.ticks = 0;
            if Instant::now() > self.deadline {
                return Err(QualityError::Timeout);
            }
        }
        Ok(())
    }
}
type Environment = HashMap<String, Datum>;
fn assign(environment: &mut Environment, name: &str, value: Datum) -> Checked<()> {
    if environment.len() >= MAX_NAMES && !environment.contains_key(name) {
        return Err(QualityError::Bounds);
    }
    environment.insert(name.into(), value);
    Ok(())
}
fn integer_result(value: Option<i64>) -> Checked<Datum> {
    let value = value.ok_or(QualityError::Bounds)?;
    if !(-MAX_INTEGER..=MAX_INTEGER).contains(&value) {
        return Err(QualityError::Bounds);
    }
    Ok(Datum::Integer(value))
}
fn evaluate(
    expression: &Expr,
    env: &mut Environment,
    budget: &mut Budget,
    program: Option<&Program>,
) -> Checked<Datum> {
    budget.spend(1)?;
    match expression {
        Expr::Integer(value) => Ok(Datum::Integer(*value)),
        Expr::Bool(value) => Ok(Datum::Bool(*value)),
        // Cloning a list name copies only its Rc handle. Actual list copying is
        // separately charged by size below, matching Python's alias semantics.
        Expr::Name(name) => env.get(name).cloned().ok_or(QualityError::Unsupported),
        Expr::List(values) => {
            if values.len() > MAX_LIST {
                return Err(QualityError::Bounds);
            }
            budget.spend(values.len())?;
            let mut out = Vec::new();
            for value in values {
                out.push(evaluate(value, env, budget, program)?.integer()?);
            }
            list(out)
        }
        Expr::Unary(operator, value) => {
            let value = evaluate(value, env, budget, program)?;
            if *operator == "not" {
                Ok(Datum::Bool(!value.truth()))
            } else {
                integer_result(value.integer()?.checked_neg())
            }
        }
        Expr::Len(value) => Ok(Datum::Integer(
            evaluate(value, env, budget, program)?
                .list()?
                .borrow()
                .len() as i64,
        )),
        Expr::Range(value) => {
            let end = evaluate(value, env, budget, program)?.integer()?;
            if !(0..=MAX_LIST as i64).contains(&end) {
                return Err(QualityError::Bounds);
            }
            budget.spend(end as usize)?;
            list((0..end).collect())
        }
        Expr::Index(values, index) => {
            let values = evaluate(values, env, budget, program)?.list()?;
            let index = evaluate(index, env, budget, program)?.integer()?;
            let values = values.borrow();
            let index = if index < 0 {
                values.len() as i64 + index
            } else {
                index
            };
            let index = usize::try_from(index).map_err(|_| QualityError::Incorrect)?;
            values
                .get(index)
                .copied()
                .map(Datum::Integer)
                .ok_or(QualityError::Incorrect)
        }
        Expr::Slice(values, start, end) => {
            let values = evaluate(values, env, budget, program)?.list()?;
            let len = values.borrow().len();
            let mut bound = |value: &Option<Box<Expr>>, default: usize| -> Checked<usize> {
                let Some(value) = value else {
                    return Ok(default);
                };
                let index = evaluate(value, env, budget, program)?.integer()?;
                Ok(if index < 0 {
                    (len as i64 + index).max(0).min(len as i64) as usize
                } else {
                    (index as usize).min(len)
                })
            };
            let start = bound(start, 0)?;
            let end = bound(end, len)?.max(start);
            budget.spend(end - start)?;
            let copied = values.borrow()[start..end].to_vec();
            list(copied)
        }
        Expr::Binary(operator, left, right) => {
            let left = evaluate(left, env, budget, program)?;
            if *operator == "and" && !left.truth() || *operator == "or" && left.truth() {
                return Ok(left);
            }
            let right = evaluate(right, env, budget, program)?;
            if ["and", "or"].contains(operator) {
                return Ok(right);
            }
            match (left, right) {
                (Datum::Integer(left), Datum::Integer(right)) => match *operator {
                    "+" => integer_result(left.checked_add(right)),
                    "-" => integer_result(left.checked_sub(right)),
                    "==" => Ok(Datum::Bool(left == right)),
                    "!=" => Ok(Datum::Bool(left != right)),
                    "<" => Ok(Datum::Bool(left < right)),
                    "<=" => Ok(Datum::Bool(left <= right)),
                    ">" => Ok(Datum::Bool(left > right)),
                    ">=" => Ok(Datum::Bool(left >= right)),
                    _ => Err(QualityError::Unsupported),
                },
                (Datum::List(left), Datum::List(right)) => {
                    let left = left.borrow();
                    let right = right.borrow();
                    budget.spend(left.len().saturating_add(right.len()))?;
                    match *operator {
                        "+" => {
                            if left.len() + right.len() > MAX_LIST {
                                return Err(QualityError::Bounds);
                            }
                            list(left.iter().chain(right.iter()).copied().collect())
                        }
                        "==" => Ok(Datum::Bool(*left == *right)),
                        "!=" => Ok(Datum::Bool(*left != *right)),
                        _ => Err(QualityError::Unsupported),
                    }
                }
                (Datum::Bool(left), Datum::Bool(right))
                    if *operator == "==" || *operator == "!=" =>
                {
                    Ok(Datum::Bool((left == right) == (*operator == "==")))
                }
                _ => Err(QualityError::Unsupported),
            }
        }
        Expr::Merge(left, right) => {
            let program = program.ok_or(QualityError::Unsupported)?; // No recursion in function bodies.
            let left = evaluate(left, env, budget, None)?.list()?;
            let right = evaluate(right, env, budget, None)?.list()?;
            invoke(program, left, right, budget)
        }
    }
}
fn execute(
    statements: &[Stmt],
    env: &mut Environment,
    budget: &mut Budget,
) -> Checked<Option<Datum>> {
    for statement in statements {
        budget.spend(1)?;
        let result = match statement {
            Stmt::Doc | Stmt::Pass => None,
            Stmt::Return(value) => Some(evaluate(value, env, budget, None)?),
            Stmt::Assign(targets, expression) => {
                let value = evaluate(expression, env, budget, None)?;
                for target in targets {
                    budget.spend(1)?;
                    assign(env, target, value.clone())?;
                }
                None
            }
            Stmt::TupleAssign(targets, expressions) => {
                let mut values = Vec::new();
                for expression in expressions {
                    values.push(evaluate(expression, env, budget, None)?);
                }
                for (target, value) in targets.iter().zip(values) {
                    budget.spend(1)?;
                    assign(env, target, value)?;
                }
                None
            }
            Stmt::Augment(name, operator, expression) => {
                let old = env.get(name).cloned().ok_or(QualityError::Unsupported)?;
                let value = evaluate(expression, env, budget, None)?;
                match (old, value) {
                    (Datum::Integer(old), Datum::Integer(value)) => assign(
                        env,
                        name,
                        integer_result(if *operator == "+=" {
                            old.checked_add(value)
                        } else {
                            old.checked_sub(value)
                        })?,
                    )?,
                    (Datum::List(old), Datum::List(value)) if *operator == "+=" => {
                        let added = value.borrow().len();
                        budget.spend(added)?;
                        if old.borrow().len() + added > MAX_LIST {
                            return Err(QualityError::Bounds);
                        }
                        let copy = value.borrow().clone();
                        old.borrow_mut().extend(copy);
                    }
                    _ => return Err(QualityError::Unsupported),
                }
                None
            }
            Stmt::Append(name, expression) => {
                let value = evaluate(expression, env, budget, None)?.integer()?;
                let values = env
                    .get(name)
                    .cloned()
                    .ok_or(QualityError::Unsupported)?
                    .list()?;
                if values.borrow().len() >= MAX_LIST {
                    return Err(QualityError::Bounds);
                }
                budget.spend(1)?;
                values.borrow_mut().push(value);
                None
            }
            Stmt::Extend(name, expression) => {
                let values = evaluate(expression, env, budget, None)?.list()?;
                let target = env
                    .get(name)
                    .cloned()
                    .ok_or(QualityError::Unsupported)?
                    .list()?;
                let added = values.borrow().len();
                budget.spend(added)?;
                if target.borrow().len() + added > MAX_LIST {
                    return Err(QualityError::Bounds);
                }
                let copy = values.borrow().clone();
                target.borrow_mut().extend(copy);
                None
            }
            Stmt::If(condition, yes, no) => execute(
                if evaluate(condition, env, budget, None)?.truth() {
                    yes
                } else {
                    no
                },
                env,
                budget,
            )?,
            Stmt::While(condition, body) => {
                let mut result = None;
                while evaluate(condition, env, budget, None)?.truth() {
                    budget.spend(1)?;
                    result = execute(body, env, budget)?;
                    if result.is_some() {
                        break;
                    }
                }
                result
            }
            Stmt::For(name, expression, body) => {
                let values = evaluate(expression, env, budget, None)?.list()?;
                // A bounded immutable snapshot avoids RefCell alias panics.
                // Reject mutation of the iterable, which this subset does not
                // attempt to emulate as a general Python iterator protocol.
                let length = values.borrow().len();
                budget.spend(length)?;
                let original = values.borrow().clone();
                let mut result = None;
                for value in &original {
                    budget.spend(1)?;
                    assign(env, name, Datum::Integer(*value))?;
                    result = execute(body, env, budget)?;
                    if result.is_some() {
                        break;
                    }
                }
                budget.spend(length)?;
                if *values.borrow() != original {
                    return Err(QualityError::Unsupported);
                }
                result
            }
        };
        if result.is_some() {
            return Ok(result);
        }
    }
    Ok(None)
}
fn invoke(
    program: &Program,
    a: Rc<RefCell<Vec<i64>>>,
    b: Rc<RefCell<Vec<i64>>>,
    budget: &mut Budget,
) -> Checked<Datum> {
    let length = a.borrow().len() + b.borrow().len();
    budget.spend(length)?;
    let original_a = a.borrow().clone();
    let original_b = b.borrow().clone();
    let mut env = HashMap::from([
        ("a".into(), Datum::List(a.clone())),
        ("b".into(), Datum::List(b.clone())),
    ]);
    let output = execute(&program.body, &mut env, budget)?.ok_or(QualityError::Incorrect)?;
    budget.spend(length)?;
    if *a.borrow() != original_a || *b.borrow() != original_b {
        return Err(QualityError::InputMutation);
    }
    Ok(output)
}
fn expected(a: &[i64], b: &[i64]) -> Vec<i64> {
    let (mut i, mut j) = (0, 0);
    let mut output = Vec::with_capacity(a.len() + b.len());
    while i < a.len() && j < b.len() {
        if a[i] <= b[j] {
            output.push(a[i]);
            i += 1;
        } else {
            output.push(b[j]);
            j += 1;
        }
    }
    output.extend_from_slice(&a[i..]);
    output.extend_from_slice(&b[j..]);
    output
}

fn validate_depth(program: &Program) -> Checked<()> {
    // Left-associative additions/index chains can create deep trees without
    // bracket nesting. Check them iteratively before recursive interpretation.
    let mut statements = program
        .body
        .iter()
        .map(|node| (node, 0))
        .collect::<Vec<_>>();
    let mut expressions = program
        .assertions
        .iter()
        .map(|node| (node, 0))
        .collect::<Vec<_>>();
    while let Some((node, depth)) = statements.pop() {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        match node {
            Stmt::Assign(_, value)
            | Stmt::Augment(_, _, value)
            | Stmt::Append(_, value)
            | Stmt::Extend(_, value)
            | Stmt::Return(value) => expressions.push((value, depth + 1)),
            Stmt::TupleAssign(_, values) => {
                expressions.extend(values.iter().map(|node| (node, depth + 1)))
            }
            Stmt::If(condition, yes, no) => {
                expressions.push((condition, depth + 1));
                statements.extend(yes.iter().chain(no.iter()).map(|node| (node, depth + 1)));
            }
            Stmt::While(condition, body) | Stmt::For(_, condition, body) => {
                expressions.push((condition, depth + 1));
                statements.extend(body.iter().map(|node| (node, depth + 1)));
            }
            Stmt::Doc | Stmt::Pass => {}
        }
    }
    while let Some((node, depth)) = expressions.pop() {
        if depth >= MAX_DEPTH {
            return Err(QualityError::Bounds);
        }
        match node {
            Expr::List(values) => expressions.extend(values.iter().map(|node| (node, depth + 1))),
            Expr::Unary(_, value) | Expr::Len(value) | Expr::Range(value) => {
                expressions.push((value, depth + 1))
            }
            Expr::Binary(_, left, right) | Expr::Index(left, right) | Expr::Merge(left, right) => {
                expressions.push((left, depth + 1));
                expressions.push((right, depth + 1));
            }
            Expr::Slice(value, start, end) => {
                expressions.push((value, depth + 1));
                expressions.extend(
                    start
                        .iter()
                        .chain(end.iter())
                        .map(|node| (node.as_ref(), depth + 1)),
                );
            }
            Expr::Integer(_) | Expr::Bool(_) | Expr::Name(_) => {}
        }
    }
    Ok(())
}

pub(super) fn validate_merge_sorted(source: &str) -> Checked<()> {
    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let program = Parser {
        tokens: lex(source, deadline)?,
        pos: 0,
        deadline,
    }
    .program()?;
    validate_depth(&program)?;
    for assertion in &program.assertions {
        let mut budget = Budget {
            left: 20_000,
            deadline,
            ticks: 0,
        };
        if !evaluate(assertion, &mut HashMap::new(), &mut budget, Some(&program))?.truth() {
            return Err(QualityError::Incorrect);
        }
    }
    let mut cases = vec![
        (vec![], vec![]),
        (vec![], vec![-4, 0, 0, 8]),
        (vec![-4, 0, 0, 8], vec![]),
        (vec![1], vec![1]),
        (vec![0, 0, 0], vec![0, 0]),
        (vec![-9, -3, -3, 7], vec![-8, -3, 0, 10]),
        (vec![-20], vec![-19, -18, -17, 0, 0, 5, 20]),
        (vec![-19, -18, -17, 0, 0, 5, 20], vec![-20]),
        (vec![-MAX_INTEGER, MAX_INTEGER], vec![-1, 1]),
    ];
    let mut seed = 0x51a7_a318u64;
    for round in 0..32 {
        let mut generate = |length: usize| {
            let mut list = Vec::new();
            for _ in 0..length {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                list.push(((seed >> 32) % 101) as i64 - 50);
            }
            list.sort_unstable();
            list
        };
        cases.push((generate((round * 17) % 65), generate((round * 29 + 3) % 65)));
    }
    for length in [32, 128, 512] {
        cases.push((
            (0..length).map(|i| (i * 2) as i64).collect(),
            (0..length).map(|i| (i * 2 + 1) as i64).collect(),
        ));
    }
    // Interleaving, unequal and all-equal large inputs expose repeated scans and
    // copying; the operation budget is evidence for these fixed cases, not a
    // mathematical proof of asymptotic complexity for arbitrary Python code.
    cases.push((vec![3; 512], vec![3; 512]));
    cases.push(((0..512).map(i64::from).collect(), vec![1024]));
    for (a, b) in cases {
        if Instant::now() > deadline {
            return Err(QualityError::Timeout);
        }
        let mut budget = Budget {
            left: 128 + 100 * (a.len() + b.len()),
            deadline,
            ticks: 0,
        };
        let wanted = expected(&a, &b);
        let output = invoke(
            &program,
            Rc::new(RefCell::new(a)),
            Rc::new(RefCell::new(b)),
            &mut budget,
        )?
        .list()?;
        budget.spend(output.borrow().len())?;
        if *output.borrow() != wanted {
            return Err(QualityError::Incorrect);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) const CORRECT: &str = r#"def merge_sorted(a, b):
    """Merge sorted integer lists without modifying the inputs."""
    result = []
    i = j = 0
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            result.append(a[i])
            i += 1
        else:
            result.append(b[j])
            j += 1
    result.extend(a[i:])
    result.extend(b[j:])
    return result
assert merge_sorted([1, 2], [2, 3]) == [1, 2, 2, 3]
assert merge_sorted([], [1]) == [1]
"#;
    fn function(body: &str) -> String {
        format!("def merge_sorted(a, b):\n    \"\"\"Fixed merge contract.\"\"\"\n{}\nassert merge_sorted([], []) == []\nassert merge_sorted([], []) == []\n", body.lines().map(|line| format!("    {line}")).collect::<Vec<_>>().join("\n"))
    }
    #[test]
    fn correct_two_pointer_merge_passes_fixed_random_and_large_cases() {
        assert_eq!(validate_merge_sorted(CORRECT), Ok(()));
        let chained = CORRECT.replace(
            "    result.extend(a[i:])\n    result.extend(b[j:])\n    return result",
            "    return result + a[i:] + b[j:]",
        );
        assert_eq!(validate_merge_sorted(&chained), Ok(()));
        assert_eq!(
            validate_merge_sorted(&format!("```python\n{CORRECT}```")),
            Ok(())
        );
    }
    #[test]
    fn single_loop_short_circuit_and_one_line_branches_are_supported() {
        let source = function("out = []; i = 0; j = 0\nwhile i < len(a) or j < len(b):\n    if j == len(b) or (i < len(a) and a[i] <= b[j]): out.append(a[i]); i += 1\n    else: out.append(b[j]); j += 1\nreturn out");
        assert_eq!(validate_merge_sorted(&source), Ok(()));
        let tail = CORRECT.replace("    result.extend(a[i:])\n    result.extend(b[j:])", "    for value in a[i:]:\n        result.append(value)\n    for value in b[j:]:\n        result.append(value)");
        assert_eq!(validate_merge_sorted(&tail), Ok(()));
        let tuple = CORRECT.replace(
            "    result = []\n    i = j = 0",
            "    result, i, j = [], 0, 0",
        );
        assert_eq!(validate_merge_sorted(&tuple), Ok(()));
        let multiline = CORRECT.replace(
            "assert merge_sorted([1, 2], [2, 3]) == [1, 2, 2, 3]",
            "assert merge_sorted(\n    [1, 2], [2, 3]\n) == [1, 2, 2, 3]",
        );
        assert_eq!(validate_merge_sorted(&multiline), Ok(()));
    }
    #[test]
    fn constant_hardcoded_unsorted_and_wrong_comparison_outputs_fail() {
        for source in [
            function("return []"),
            function("return [1, 2, 2, 3]"),
            function("return a + b"),
            CORRECT.replace("a[i] <= b[j]", "a[i] >= b[j]"),
        ] {
            assert!(validate_merge_sorted(&source).is_err());
        }
    }
    #[test]
    fn aliases_cannot_hide_input_mutation() {
        let mutate = function("out = a\nout.extend(b)\nreturn out");
        assert_eq!(
            validate_merge_sorted(&mutate),
            Err(QualityError::InputMutation)
        );
        let augment = function("a += b\nreturn a");
        assert_eq!(
            validate_merge_sorted(&augment),
            Err(QualityError::InputMutation)
        );
    }
    #[test]
    fn quadratic_copying_is_charged_and_rejected_even_when_results_are_correct() {
        let source = function("out = []\nwhile len(a) and len(b):\n    if a[0] <= b[0]:\n        out.append(a[0]); a = a[1:]\n    else:\n        out.append(b[0]); b = b[1:]\nreturn out + a + b");
        assert_eq!(validate_merge_sorted(&source), Err(QualityError::NonLinear));
    }
    #[test]
    fn imports_sorting_io_introspection_and_arbitrary_calls_are_rejected_without_execution() {
        for body in [
            "import os\nreturn []",
            "from os import system\nreturn []",
            "return sorted(a + b)",
            "a.sort()\nreturn a",
            "open('must-not-exist', 'w')\nreturn []",
            "return eval('1')",
            "exec('while True: pass')\nreturn []",
            "return a.__class__",
            "return getattr(a, 'append')",
            "return globals()",
            "return merge_sorted(a, b)",
            "while True: pass\nreturn []",
            "x = [0]\nx.extend(x)\nwhile True: x.extend(x)\nreturn x",
            "if False: open('never-run')\nreturn []",
            "def escape(): return []\nreturn escape()",
        ] {
            let started = Instant::now();
            assert!(
                validate_merge_sorted(&function(body)).is_err(),
                "unsafe or unsupported source unexpectedly accepted"
            );
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }
    #[test]
    fn source_line_digit_ast_and_list_limits_are_enforced_before_unbounded_work() {
        assert_eq!(
            validate_merge_sorted(&"x".repeat(MAX_SOURCE + 1)),
            Err(QualityError::Bounds)
        );
        assert_eq!(
            validate_merge_sorted(&"# comment\n".repeat(MAX_LINES + 1)),
            Err(QualityError::Bounds)
        );
        assert_eq!(
            validate_merge_sorted(&function("return 9999999999999999999999999999")),
            Err(QualityError::Bounds)
        );
        assert_eq!(
            validate_merge_sorted(&function(&format!(
                "x = {}\nreturn []",
                "1 + ".repeat(100) + "1"
            ))),
            Err(QualityError::Bounds)
        );
        assert_eq!(
            validate_merge_sorted(&function(&format!(
                "return {}0{}",
                "(".repeat(25),
                ")".repeat(25)
            ))),
            Err(QualityError::Bounds)
        );
        assert!(validate_merge_sorted(&function("x = 1000000000\nx += 1\nreturn []")).is_err());
        assert!(validate_merge_sorted(&function("return range(1000000000)")).is_err());
    }
    #[test]
    fn strict_function_docstring_and_two_assert_contract_cannot_be_bypassed() {
        for source in [
            CORRECT.replace("def merge_sorted(a, b):", "def anything(a, b):"),
            CORRECT.replace(
                "    \"\"\"Merge sorted integer lists without modifying the inputs.\"\"\"\n",
                "",
            ),
            CORRECT.replace("assert merge_sorted([], [1]) == [1]", "assert True"),
            format!("{CORRECT}assert merge_sorted([], []) == []\n"),
            format!("{CORRECT}print('must never execute')\n"),
            CORRECT.replace(
                "assert merge_sorted([], [1]) == [1]",
                "assert merge_sorted([], [1]) == [2]",
            ),
        ] {
            assert!(validate_merge_sorted(&source).is_err());
        }
    }
    #[test]
    fn runtime_deadline_and_step_budget_fail_closed() {
        let program = Parser {
            tokens: lex(CORRECT, Instant::now() + TOTAL_TIMEOUT).unwrap(),
            pos: 0,
            deadline: Instant::now() + TOTAL_TIMEOUT,
        }
        .program()
        .unwrap();
        let mut budget = Budget {
            left: 1000,
            deadline: Instant::now() - Duration::from_millis(1),
            ticks: 128,
        };
        assert_eq!(
            execute(&program.body, &mut HashMap::new(), &mut budget).unwrap_err(),
            QualityError::Timeout
        );
        let mut budget = Budget {
            left: 0,
            deadline: Instant::now() + TOTAL_TIMEOUT,
            ticks: 0,
        };
        assert_eq!(
            execute(&program.body, &mut HashMap::new(), &mut budget).unwrap_err(),
            QualityError::NonLinear
        );
        let error = validate_merge_sorted(&function("while True: pass\nreturn []")).unwrap_err();
        assert!(!error.reason().contains("while True"));
    }
    #[test]
    fn maximum_token_chains_truncated_syntax_and_deep_ast_drops_do_not_panic() {
        let fixed_tokens = lex(
            &function("x = 1\nreturn []"),
            Instant::now() + TOTAL_TIMEOUT,
        )
        .unwrap()
        .len();
        let operators = (MAX_TOKENS - fixed_tokens) / 2;
        let deep_chain = function(&format!(
            "x = {}\nreturn []",
            "1 + ".repeat(operators) + "1"
        ));
        assert!(deep_chain.len() < MAX_SOURCE);
        let tokens = lex(&deep_chain, Instant::now() + TOTAL_TIMEOUT).unwrap();
        assert!((MAX_TOKENS - 1..=MAX_TOKENS).contains(&tokens.len()));
        let result = std::panic::catch_unwind(|| validate_merge_sorted(&deep_chain));
        assert_eq!(result.unwrap(), Err(QualityError::Bounds));
        let excess_tokens = function(&format!(
            "x = {}\nreturn []",
            "1 + ".repeat(MAX_TOKENS / 2) + "1"
        ));
        assert!(excess_tokens.len() < MAX_SOURCE);
        assert_eq!(
            lex(&excess_tokens, Instant::now() + TOTAL_TIMEOUT).unwrap_err(),
            QualityError::Bounds
        );
        let mut malformed = vec![
            "def merge_sorted(".to_owned(),
            "def merge_sorted(a, b):\n".to_owned(),
            "def merge_sorted(a, b):\n    \"\"\"unclosed".to_owned(),
            CORRECT.replace("return result", "return result["),
            CORRECT.replace("if a[i] <= b[j]:", "if:"),
            CORRECT.replace("return result", "return\0result"),
            function(&format!(
                "return {}0{}",
                "(".repeat(MAX_DEPTH),
                ")".repeat(MAX_DEPTH)
            )),
        ];
        for end in (0..CORRECT.len())
            .filter(|index| CORRECT.is_char_boundary(*index))
            .step_by(11)
        {
            malformed.push(CORRECT[..end].to_owned());
        }
        for source in malformed {
            let result = std::panic::catch_unwind(|| validate_merge_sorted(&source));
            assert!(result.is_ok(), "bounded malformed syntax must never panic");
            assert!(result.unwrap().is_err());
        }
    }
}
