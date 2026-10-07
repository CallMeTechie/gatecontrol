CREATE TABLE greetings (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
INSERT INTO greetings (text) VALUES ('first');
