use crate::RpcError;
use std::{
    fs::{File, OpenOptions},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
};

pub fn current_identity() -> Result<String, RpcError> {
    Ok(unsafe { libc::geteuid() }.to_string())
}

pub fn ipc_directory(data_dir: &Path) -> Result<PathBuf, RpcError> {
    let path = data_dir.join(".ipc");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != unsafe { libc::geteuid() }
            {
                return Err(RpcError::new(
                    "ipc_permissions",
                    "IPC目录的归属或文件类型无效",
                ));
            }
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| RpcError::new("ipc_permissions", e.to_string()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let created = std::fs::DirBuilder::new()
                .recursive(false)
                .mode(0o700)
                .create(&path);
            match created {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return ipc_directory(data_dir);
                }
                Err(error) => return Err(RpcError::new("ipc_permissions", error.to_string())),
            }
        }
        Err(error) => return Err(RpcError::new("ipc_permissions", error.to_string())),
    }
    Ok(path)
}

pub struct SingleInstance {
    _file: File,
}
impl SingleInstance {
    pub fn acquire(data_dir: &Path) -> Result<Self, RpcError> {
        let directory = ipc_directory(data_dir)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("supervisor.lock"))
            .map_err(|e| RpcError::new("instance_lock", e.to_string()))?;
        if file
            .metadata()
            .map_err(|e| RpcError::new("instance_lock", e.to_string()))?
            .uid()
            != unsafe { libc::geteuid() }
        {
            return Err(RpcError::new("instance_lock", "后台锁文件不是当前用户拥有"));
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                return Err(RpcError::new("already_running", "当前用户后台已运行"));
            }
            return Err(RpcError::new("instance_lock", error.to_string()));
        }
        // Only the owner holding this kernel lock may remove an abandoned socket.
        // Live owners retain the lock until the process or guard exits.
        let socket = crate::socket_path(data_dir)?;
        if socket.exists() {
            std::fs::remove_file(socket)
                .map_err(|e| RpcError::new("stale_socket", e.to_string()))?;
        }
        Ok(Self { _file: file })
    }
}
