-- ClickHouse v23 script to create a table equivalent to the Student table

-- Create the Student table
CREATE TABLE Student
(
    id UInt32,
    first_name String,
    middle_name String,
    last_name String,
    birthday Date,
    address String
) ENGINE = MergeTree()
PRIMARY KEY (id);

-- Insert test data with both Cyrillic and English names - one row at a time for ClickHouse compatibility

-- English names
INSERT INTO Student VALUES (1, 'John', 'Michael', 'Smith', '2001-05-15', '123 Main St, New York');
INSERT INTO Student VALUES (2, 'Emma', 'Rose', 'Johnson', '2002-08-22', '456 Oak Ave, London');
INSERT INTO Student VALUES (3, 'Alexander', 'James', 'Williams', '2000-03-10', '789 Pine Rd, Sydney');
INSERT INTO Student VALUES (4, 'Sophia', 'Grace', 'Brown', '2003-11-30', '101 Maple Dr, Toronto');
INSERT INTO Student VALUES (5, 'William', 'Thomas', 'Jones', '1999-07-18', '202 Cedar Ln, Chicago');

-- Cyrillic names
INSERT INTO Student VALUES (6, 'Иван', 'Петрович', 'Сидоров', '2001-02-12', 'ул. Ленина 15, Москва');
INSERT INTO Student VALUES (7, 'Анна', 'Сергеевна', 'Иванова', '2002-06-23', 'пр. Мира 42, Санкт-Петербург');
INSERT INTO Student VALUES (8, 'Дмитрий', 'Александрович', 'Петров', '2000-09-05', 'ул. Гагарина 7, Новосибирск');
INSERT INTO Student VALUES (9, 'Екатерина', 'Андреевна', 'Смирнова', '2003-04-18', 'ул. Пушкина 22, Казань');
INSERT INTO Student VALUES (10, 'Алексей', 'Николаевич', 'Кузнецов', '1998-11-30', 'пр. Победы 56, Екатеринбург');

-- Mixed names
INSERT INTO Student VALUES (11, 'Mikhail', 'Иванович', 'Johnson', '2001-07-29', 'Baker Street 221B, London');
INSERT INTO Student VALUES (12, 'Natalia', 'Elizabeth', 'Волкова', '2002-12-15', '10 Downing Street, London');
INSERT INTO Student VALUES (13, 'Сергей', 'William', 'Thompson', '2000-01-23', 'Тверская 13, Москва');
INSERT INTO Student VALUES (14, 'Victoria', 'Александровна', 'Smith', '2003-08-07', 'Red Square 1, Moscow');
INSERT INTO Student VALUES (15, 'Андрей', 'James', 'Морозов', '1999-05-04', '1600 Pennsylvania Ave, Washington');

-- Query to find students born after 2000 (similar to our previous anti-top query)
SELECT
    id AS student_id,
    first_name,
    last_name,
    birthday,
    address
FROM Student
WHERE birthday > '2000-01-01'
ORDER BY birthday ASC;

-- Create a view for students born after 2000
CREATE VIEW StudentsAfter2000 AS
SELECT *
FROM Student
WHERE birthday > '2000-01-01';

-- Query to clean up names and keep only lowercase Cyrillic letters
SELECT
    id,
    -- Clean first_name: keep only lowercase Cyrillic letters
    lower(replaceRegexpAll(first_name, '[^а-яё]', '')) AS clean_first_name,
    -- Clean middle_name: keep only lowercase Cyrillic letters
    lower(replaceRegexpAll(middle_name, '[^а-яё]', '')) AS clean_middle_name,
    -- Clean last_name: keep only lowercase Cyrillic letters
    lower(replaceRegexpAll(last_name, '[^а-яё]', '')) AS clean_last_name,
    birthday,
    address
FROM Student
WHERE
    (lower(replaceRegexpAll(first_name, '[^а-яё]', '')) != '') OR
    (lower(replaceRegexpAll(middle_name, '[^а-яё]', '')) != '') OR
    (lower(replaceRegexpAll(last_name, '[^а-яё]', '')) != '')
ORDER BY id;

-- Create a view with only students who have at least one Cyrillic name component
CREATE VIEW StudentsWithCyrillicNames AS
SELECT
    id,
    first_name,
    middle_name,
    last_name,
    birthday,
    address
FROM Student
WHERE
    (lower(replaceRegexpAll(first_name, '[^а-яё]', '')) != '') OR
    (lower(replaceRegexpAll(middle_name, '[^а-яё]', '')) != '') OR
    (lower(replaceRegexpAll(last_name, '[^а-яё]', '')) != '');


-- Alternative version that shows both original and cleaned names
SELECT
    id,
    first_name,
    lower(replaceRegexpAll(first_name, '[^а-яё]', '')) AS clean_first_name,
    middle_name,
    lower(replaceRegexpAll(middle_name, '[^а-яё]', '')) AS clean_middle_name,
    last_name,
    lower(replaceRegexpAll(last_name, '[^а-яё]', '')) AS clean_last_name
FROM Student
ORDER BY id;

------------- UPDATE

-- ClickHouse script to keep ONLY lowercase Cyrillic characters in name fields
-- This will remove uppercase Cyrillic, Latin, numbers, spaces, and all other characters

-- Create a new table with the cleaned data
CREATE TABLE Student_Clean
(
    id UInt32,
    first_name String,
    middle_name String,
    last_name String,
    birthday Date,
    address String
) ENGINE = MergeTree()
ORDER BY id;

-- Insert the cleaned data into the new table
INSERT INTO Student_Clean
SELECT
    id,
    replaceRegexpAll(lower(first_name), '[^а-яё]', '') AS first_name,
    replaceRegexpAll(lower(middle_name), '[^а-яё]', '') AS middle_name,
    replaceRegexpAll(lower(last_name), '[^а-яё]', '') AS last_name,
    birthday,
    address
FROM Student;

-- Drop the original table
DROP TABLE Student;

-- Rename the clean table to the original name
RENAME TABLE Student_Clean TO Student;

-- Remove rows where all name fields are empty after cleaning
ALTER TABLE Student DELETE WHERE first_name = '' AND middle_name = '' AND last_name = '';

-- Verify the results
SELECT * FROM Student ORDER BY id;

-- Show only rows that still have data after cleaning
SELECT * FROM Student 
WHERE first_name != '' OR middle_name != '' OR last_name != '' 
ORDER BY id;

-------UPDATE 2 through Mutation (classic)

ALTER TABLE Student
UPDATE
    first_name  = replaceRegexpAll(lower(first_name),  '[^а-яё]', ''),
    middle_name = replaceRegexpAll(lower(middle_name), '[^а-яё]', ''),
    last_name   = replaceRegexpAll(lower(last_name),   '[^а-яё]', '')
WHERE 1 = 1
SETTINGS mutations_sync = 1;

-- Verify results
SELECT id, first_name, middle_name, last_name FROM Student ORDER BY id;

--------UPDATE 3 Lightweight Update (не работает в версии, которая указана, но в новых работает)

-- Enable lightweight UPDATE for this session (experimental in v23.x)
SET allow_experimental_lightweight_update = 1;

-- Lightweight UPDATE: lower() first (А–Я → а–я), then strip non-Cyrillic via regex
UPDATE Student
SET
    first_name  = replaceRegexpAll(lower(first_name),  '[^а-яё]', ''),
    middle_name = replaceRegexpAll(lower(middle_name), '[^а-яё]', ''),
    last_name   = replaceRegexpAll(lower(last_name),   '[^а-яё]', '')
WHERE 1 = 1;