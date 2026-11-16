$ErrorActionPreference = "Stop"

if (-not ("CgvSqliteStore" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CgvStoreRecord
{
    public string Payload;
    public long Revision;
}

public static class CgvSqliteStore
{
    private const int SQLITE_OK = 0;
    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;
    private const int SQLITE_OPEN_READONLY = 0x00000001;
    private const int SQLITE_OPEN_READWRITE = 0x00000002;
    private const int SQLITE_OPEN_CREATE = 0x00000004;
    private static readonly IntPtr SQLITE_TRANSIENT = new IntPtr(-1);
    private static readonly object Sync = new object();
    private static readonly HashSet<string> Migrated =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open_v2(
        IntPtr filename,
        out IntPtr database,
        int flags,
        IntPtr vfs
    );

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close_v2(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_exec(
        IntPtr database,
        IntPtr sql,
        IntPtr callback,
        IntPtr callbackArgument,
        out IntPtr errorMessage
    );

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void sqlite3_free(IntPtr pointer);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr database);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(
        IntPtr database,
        IntPtr sql,
        int byteCount,
        out IntPtr statement,
        IntPtr tail
    );

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_bind_text(
        IntPtr statement,
        int index,
        IntPtr value,
        int byteCount,
        IntPtr destructor
    );

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_bind_int64(
        IntPtr statement,
        int index,
        long value
    );

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_bytes(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern long sqlite3_column_int64(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_backup_init(
        IntPtr destination,
        IntPtr destinationName,
        IntPtr source,
        IntPtr sourceName
    );

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_backup_step(IntPtr backup, int pageCount);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_backup_finish(IntPtr backup);

    private static IntPtr Utf8(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value + "\0");
        IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, pointer, bytes.Length);
        return pointer;
    }

    private static string Utf8String(IntPtr pointer, int byteCount)
    {
        if (pointer == IntPtr.Zero || byteCount <= 0) return "";
        byte[] bytes = new byte[byteCount];
        Marshal.Copy(pointer, bytes, 0, byteCount);
        return Encoding.UTF8.GetString(bytes);
    }

    private static string Error(IntPtr database)
    {
        IntPtr pointer = sqlite3_errmsg(database);
        if (pointer == IntPtr.Zero) return "Unknown SQLite error.";
        int length = 0;
        while (Marshal.ReadByte(pointer, length) != 0) length++;
        return Utf8String(pointer, length);
    }

    private static IntPtr Open(string path, int flags)
    {
        IntPtr pathPointer = Utf8(path);
        try
        {
            IntPtr database;
            int result = sqlite3_open_v2(pathPointer, out database, flags, IntPtr.Zero);
            if (result != SQLITE_OK)
            {
                string message = database == IntPtr.Zero
                    ? "Unable to open SQLite database."
                    : Error(database);
                if (database != IntPtr.Zero) sqlite3_close_v2(database);
                throw new InvalidOperationException(message);
            }
            return database;
        }
        finally
        {
            Marshal.FreeHGlobal(pathPointer);
        }
    }

    private static IntPtr Open(string path)
    {
        return Open(path, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    }

    private static void Execute(IntPtr database, string sql)
    {
        IntPtr sqlPointer = Utf8(sql);
        IntPtr errorPointer = IntPtr.Zero;
        try
        {
            int result = sqlite3_exec(
                database,
                sqlPointer,
                IntPtr.Zero,
                IntPtr.Zero,
                out errorPointer
            );
            if (result != SQLITE_OK)
            {
                string message = errorPointer == IntPtr.Zero
                    ? Error(database)
                    : Marshal.PtrToStringAnsi(errorPointer);
                throw new InvalidOperationException(message);
            }
        }
        finally
        {
            if (errorPointer != IntPtr.Zero) sqlite3_free(errorPointer);
            Marshal.FreeHGlobal(sqlPointer);
        }
    }

    private static bool CanPrepare(IntPtr database, string sql)
    {
        IntPtr sqlPointer = Utf8(sql);
        IntPtr statement = IntPtr.Zero;
        try
        {
            return sqlite3_prepare_v2(
                database, sqlPointer, -1, out statement, IntPtr.Zero
            ) == SQLITE_OK;
        }
        finally
        {
            if (statement != IntPtr.Zero) sqlite3_finalize(statement);
            Marshal.FreeHGlobal(sqlPointer);
        }
    }

    private static long UnixMilliseconds()
    {
        DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        return (long)(DateTime.UtcNow - epoch).TotalMilliseconds;
    }

    // Revisions are issued only here. Each one is later than every revision
    // issued before it, including across a data reset or a restored backup,
    // because it never falls below the current time in milliseconds.
    private static long NextRevision(long current)
    {
        return Math.Max(current + 1, UnixMilliseconds());
    }

    private static void Initialize(IntPtr database, string path)
    {
        Execute(database,
            "PRAGMA busy_timeout = 3000;" +
            "PRAGMA journal_mode = WAL;" +
            "PRAGMA synchronous = NORMAL;" +
            "CREATE TABLE IF NOT EXISTS app_state (" +
            "id INTEGER PRIMARY KEY CHECK (id = 1)," +
            "payload TEXT NOT NULL," +
            "updated_at TEXT NOT NULL," +
            "revision INTEGER NOT NULL DEFAULT 0" +
            ");"
        );
        if (Migrated.Contains(path)) return;

        // Databases created by v1.5.0 and earlier have no revision column.
        // Adding it keeps their row intact and stays readable by v1.5.0.
        if (!CanPrepare(database, "SELECT revision FROM app_state LIMIT 0"))
        {
            Execute(database,
                "ALTER TABLE app_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;"
            );
        }
        // A row without a revision (legacy data, or data written by v1.5.0
        // after a downgrade) receives a fresh one.
        Execute(database,
            "UPDATE app_state SET revision = " + NextRevision(0) +
            " WHERE id = 1 AND revision <= 0;"
        );
        Migrated.Add(path);
    }

    private static CgvStoreRecord ReadRecord(IntPtr database, bool hasRevision)
    {
        IntPtr sql = Utf8(hasRevision
            ? "SELECT payload, revision FROM app_state WHERE id = 1"
            : "SELECT payload, 0 FROM app_state WHERE id = 1");
        IntPtr statement = IntPtr.Zero;
        try
        {
            int prepared = sqlite3_prepare_v2(
                database, sql, -1, out statement, IntPtr.Zero
            );
            if (prepared != SQLITE_OK)
                throw new InvalidOperationException(Error(database));

            int stepped = sqlite3_step(statement);
            if (stepped == SQLITE_DONE) return null;
            if (stepped != SQLITE_ROW)
                throw new InvalidOperationException(Error(database));

            CgvStoreRecord record = new CgvStoreRecord();
            IntPtr value = sqlite3_column_text(statement, 0);
            int byteCount = sqlite3_column_bytes(statement, 0);
            record.Payload = Utf8String(value, byteCount);
            record.Revision = sqlite3_column_int64(statement, 1);
            return record;
        }
        finally
        {
            if (statement != IntPtr.Zero) sqlite3_finalize(statement);
            Marshal.FreeHGlobal(sql);
        }
    }

    public static CgvStoreRecord Read(string path)
    {
        lock (Sync)
        {
            IntPtr database = Open(path);
            try
            {
                Initialize(database, path);
                return ReadRecord(database, true);
            }
            finally
            {
                sqlite3_close_v2(database);
            }
        }
    }

    // Reads a database file without changing it (for example a backup).
    public static CgvStoreRecord ReadSnapshot(string path)
    {
        lock (Sync)
        {
            IntPtr database = Open(path, SQLITE_OPEN_READONLY);
            try
            {
                return ReadRecord(
                    database,
                    CanPrepare(database, "SELECT revision FROM app_state LIMIT 0")
                );
            }
            finally
            {
                sqlite3_close_v2(database);
            }
        }
    }

    // Optimistic concurrency: the write succeeds only when the caller's base
    // revision is still the stored one (0 means "the store is empty"). The
    // comparison and the write happen inside one immediate transaction.
    // On a mismatch nothing is written and the out value is the stored revision.
    public static bool TryWrite(
        string path,
        string payload,
        string updatedAt,
        long baseRevision,
        out long revision
    )
    {
        lock (Sync)
        {
            IntPtr database = Open(path);
            try
            {
                Initialize(database, path);
                Execute(database, "BEGIN IMMEDIATE;");
                bool finished = false;
                try
                {
                    CgvStoreRecord stored = ReadRecord(database, true);
                    long current = stored == null ? 0 : stored.Revision;
                    if (current != baseRevision)
                    {
                        Execute(database, "ROLLBACK;");
                        finished = true;
                        revision = current;
                        return false;
                    }

                    long next = NextRevision(current);
                    IntPtr sql = Utf8(
                        "INSERT OR REPLACE INTO app_state " +
                        "(id, payload, updated_at, revision) VALUES (1, ?1, ?2, ?3)"
                    );
                    IntPtr statement = IntPtr.Zero;
                    IntPtr payloadPointer = Utf8(payload);
                    IntPtr updatedPointer = Utf8(updatedAt);
                    try
                    {
                        if (sqlite3_prepare_v2(
                            database, sql, -1, out statement, IntPtr.Zero
                        ) != SQLITE_OK)
                            throw new InvalidOperationException(Error(database));
                        if (sqlite3_bind_text(
                            statement, 1, payloadPointer,
                            Encoding.UTF8.GetByteCount(payload), SQLITE_TRANSIENT
                        ) != SQLITE_OK)
                            throw new InvalidOperationException(Error(database));
                        if (sqlite3_bind_text(
                            statement, 2, updatedPointer,
                            Encoding.UTF8.GetByteCount(updatedAt), SQLITE_TRANSIENT
                        ) != SQLITE_OK)
                            throw new InvalidOperationException(Error(database));
                        if (sqlite3_bind_int64(statement, 3, next) != SQLITE_OK)
                            throw new InvalidOperationException(Error(database));
                        if (sqlite3_step(statement) != SQLITE_DONE)
                            throw new InvalidOperationException(Error(database));
                    }
                    finally
                    {
                        if (statement != IntPtr.Zero) sqlite3_finalize(statement);
                        Marshal.FreeHGlobal(payloadPointer);
                        Marshal.FreeHGlobal(updatedPointer);
                        Marshal.FreeHGlobal(sql);
                    }
                    Execute(database, "COMMIT;");
                    finished = true;
                    revision = next;
                    return true;
                }
                finally
                {
                    if (!finished)
                    {
                        try { Execute(database, "ROLLBACK;"); } catch { }
                    }
                }
            }
            finally
            {
                sqlite3_close_v2(database);
            }
        }
    }

    private static string IntegrityCheckCore(string path)
    {
        IntPtr database = Open(path, SQLITE_OPEN_READONLY);
        IntPtr sql = Utf8("PRAGMA integrity_check");
        IntPtr statement = IntPtr.Zero;
        try
        {
            if (sqlite3_prepare_v2(
                database, sql, -1, out statement, IntPtr.Zero
            ) != SQLITE_OK)
                throw new InvalidOperationException(Error(database));
            if (sqlite3_step(statement) != SQLITE_ROW)
                throw new InvalidOperationException(Error(database));
            return Utf8String(
                sqlite3_column_text(statement, 0),
                sqlite3_column_bytes(statement, 0)
            );
        }
        finally
        {
            if (statement != IntPtr.Zero) sqlite3_finalize(statement);
            Marshal.FreeHGlobal(sql);
            sqlite3_close_v2(database);
        }
    }

    public static string IntegrityCheck(string path)
    {
        lock (Sync)
        {
            return IntegrityCheckCore(path);
        }
    }

    // Writes a consistent, self-contained copy of the database using the
    // SQLite online backup API, so committed transactions that still live in
    // the write-ahead log are included. The copy is verified before it
    // replaces any existing file at the destination.
    public static void Backup(string path, string destination)
    {
        lock (Sync)
        {
            string temporary = destination + ".tmp";
            File.Delete(temporary);
            File.Delete(temporary + "-journal");
            IntPtr source = Open(path);
            try
            {
                Initialize(source, path);
                IntPtr target = Open(temporary);
                IntPtr name = Utf8("main");
                try
                {
                    IntPtr backup = sqlite3_backup_init(target, name, source, name);
                    if (backup == IntPtr.Zero)
                        throw new InvalidOperationException(Error(target));
                    int stepped = sqlite3_backup_step(backup, -1);
                    int finished = sqlite3_backup_finish(backup);
                    if (stepped != SQLITE_DONE || finished != SQLITE_OK)
                        throw new InvalidOperationException(Error(target));
                    // A single file with no -wal/-shm companions.
                    Execute(target, "PRAGMA journal_mode = DELETE;");
                }
                finally
                {
                    Marshal.FreeHGlobal(name);
                    sqlite3_close_v2(target);
                }
            }
            finally
            {
                sqlite3_close_v2(source);
            }

            string check = IntegrityCheckCore(temporary);
            if (check != "ok")
            {
                File.Delete(temporary);
                throw new InvalidOperationException("Backup failed verification: " + check);
            }
            File.Delete(destination);
            File.Move(temporary, destination);
        }
    }
}
"@
}

function Initialize-CgvDataStore {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)

  [void][CgvSqliteStore]::Read($DatabasePath)
}

# Returns an object with Payload and Revision, or $null when nothing is stored.
function Read-CgvRecord {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)

  return [CgvSqliteStore]::Read($DatabasePath)
}

function Read-CgvData {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)

  $record = [CgvSqliteStore]::Read($DatabasePath)
  if ($null -eq $record) { return $null }
  return $record.Payload
}

# Stores the payload only if -BaseRevision is still the stored revision
# (0 = empty store). Returns Written (bool) and Revision (the new revision,
# or the stored one when the write was refused).
function Write-CgvData {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$Payload,
    [Parameter(Mandatory = $true)][string]$UpdatedAt,
    [Parameter(Mandatory = $true)][long]$BaseRevision
  )

  $revision = [long]0
  $written = [CgvSqliteStore]::TryWrite(
    $DatabasePath, $Payload, $UpdatedAt, $BaseRevision, [ref]$revision
  )
  return [PSCustomObject]@{ Written = $written; Revision = $revision }
}

# Creates a verified single-file SQLite snapshot of the database.
function Backup-CgvData {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  [CgvSqliteStore]::Backup($DatabasePath, $Destination)
}
