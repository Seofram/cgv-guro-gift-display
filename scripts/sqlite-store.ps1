$ErrorActionPreference = "Stop"

if (-not ("CgvSqliteStore" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CgvSqliteStore
{
    private const int SQLITE_OK = 0;
    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;
    private const int SQLITE_OPEN_READWRITE = 0x00000002;
    private const int SQLITE_OPEN_CREATE = 0x00000004;
    private static readonly IntPtr SQLITE_TRANSIENT = new IntPtr(-1);
    private static readonly object Sync = new object();

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
    private static extern int sqlite3_step(IntPtr statement);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_bytes(IntPtr statement, int column);

    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr statement);

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

    private static IntPtr Open(string path)
    {
        IntPtr pathPointer = Utf8(path);
        try
        {
            IntPtr database;
            int result = sqlite3_open_v2(
                pathPointer,
                out database,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                IntPtr.Zero
            );
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

    private static void Initialize(IntPtr database)
    {
        Execute(database,
            "PRAGMA journal_mode = WAL;" +
            "PRAGMA synchronous = NORMAL;" +
            "CREATE TABLE IF NOT EXISTS app_state (" +
            "id INTEGER PRIMARY KEY CHECK (id = 1)," +
            "payload TEXT NOT NULL," +
            "updated_at TEXT NOT NULL" +
            ");"
        );
    }

    public static string Read(string path)
    {
        lock (Sync)
        {
            IntPtr database = Open(path);
            try
            {
                Initialize(database);
                IntPtr sql = Utf8("SELECT payload FROM app_state WHERE id = 1");
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

                    IntPtr value = sqlite3_column_text(statement, 0);
                    int byteCount = sqlite3_column_bytes(statement, 0);
                    return Utf8String(value, byteCount);
                }
                finally
                {
                    if (statement != IntPtr.Zero) sqlite3_finalize(statement);
                    Marshal.FreeHGlobal(sql);
                }
            }
            finally
            {
                sqlite3_close_v2(database);
            }
        }
    }

    public static void Write(string path, string payload, string updatedAt)
    {
        lock (Sync)
        {
            IntPtr database = Open(path);
            try
            {
                Initialize(database);
                IntPtr sql = Utf8(
                    "INSERT OR REPLACE INTO app_state " +
                    "(id, payload, updated_at) VALUES (1, ?1, ?2)"
                );
                IntPtr statement = IntPtr.Zero;
                IntPtr payloadPointer = Utf8(payload);
                IntPtr updatedPointer = Utf8(updatedAt);
                try
                {
                    int prepared = sqlite3_prepare_v2(
                        database, sql, -1, out statement, IntPtr.Zero
                    );
                    if (prepared != SQLITE_OK)
                        throw new InvalidOperationException(Error(database));

                    int payloadBytes = Encoding.UTF8.GetByteCount(payload);
                    int updatedBytes = Encoding.UTF8.GetByteCount(updatedAt);
                    if (sqlite3_bind_text(
                        statement, 1, payloadPointer, payloadBytes, SQLITE_TRANSIENT
                    ) != SQLITE_OK)
                        throw new InvalidOperationException(Error(database));
                    if (sqlite3_bind_text(
                        statement, 2, updatedPointer, updatedBytes, SQLITE_TRANSIENT
                    ) != SQLITE_OK)
                        throw new InvalidOperationException(Error(database));

                    int stepped = sqlite3_step(statement);
                    if (stepped != SQLITE_DONE)
                        throw new InvalidOperationException(Error(database));
                }
                finally
                {
                    if (statement != IntPtr.Zero) sqlite3_finalize(statement);
                    Marshal.FreeHGlobal(payloadPointer);
                    Marshal.FreeHGlobal(updatedPointer);
                    Marshal.FreeHGlobal(sql);
                }
            }
            finally
            {
                sqlite3_close_v2(database);
            }
        }
    }
}
"@
}

function Initialize-CgvDataStore {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)

  [void][CgvSqliteStore]::Read($DatabasePath)
}

function Read-CgvData {
  param([Parameter(Mandatory = $true)][string]$DatabasePath)

  return [CgvSqliteStore]::Read($DatabasePath)
}

function Write-CgvData {
  param(
    [Parameter(Mandatory = $true)][string]$DatabasePath,
    [Parameter(Mandatory = $true)][string]$Payload,
    [Parameter(Mandatory = $true)][string]$UpdatedAt
  )

  [CgvSqliteStore]::Write($DatabasePath, $Payload, $UpdatedAt)
}
