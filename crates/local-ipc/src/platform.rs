use crate::RpcError;
use std::{ffi::c_void, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, HANDLE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    },
    System::Threading::{CreateMutexW, GetCurrentProcess, OpenProcessToken},
};

pub fn current_identity() -> Result<String, RpcError> {
    unsafe {
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(RpcError::new(
                "user_identity",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        let mut len = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len);
        // An aligned allocation is required before reading TOKEN_USER.
        let mut words = vec![0usize; (len as usize).div_ceil(std::mem::size_of::<usize>())];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            words.as_mut_ptr() as *mut c_void,
            len,
            &mut len,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(RpcError::new(
                "user_identity",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        let user = &*(words.as_ptr() as *const TOKEN_USER);
        let mut text = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(RpcError::new(
                "user_identity",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        let mut chars = 0;
        while *text.add(chars) != 0 {
            chars += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, chars));
        LocalFree(text as *mut c_void);
        Ok(sid)
    }
}

pub struct UserSecurity {
    descriptor: *mut c_void,
}
// Windows only reads the immutable security descriptor while creating handles.
unsafe impl Send for UserSecurity {}
unsafe impl Sync for UserSecurity {}
impl UserSecurity {
    pub fn new() -> Result<Self, RpcError> {
        // No inherited ACE, Everyone, network user or default Named Pipe DACL.
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})", current_identity()?)
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(RpcError::new(
                "pipe_acl",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        Ok(Self { descriptor })
    }
    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }
    pub fn create_pipe(
        &self,
        name: &str,
        first: bool,
    ) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, RpcError> {
        let mut attrs = self.attributes();
        unsafe {
            tokio::net::windows::named_pipe::ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(name, &mut attrs as *mut _ as *mut c_void)
        }
        .map_err(|e| RpcError::unavailable(format!("创建用户专属后台管道失败: {e}")))
    }
}
impl Drop for UserSecurity {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.descriptor);
        }
    }
}

pub struct SingleInstance {
    handle: HANDLE,
}
// The mutex handle is only retained and closed; no access is made from workers.
unsafe impl Send for SingleInstance {}
unsafe impl Sync for SingleInstance {}
impl SingleInstance {
    pub fn acquire(data_dir: &std::path::Path) -> Result<Self, RpcError> {
        Self::acquire_scoped(data_dir, "supervisor")
    }
    /// Independent UI operation locks share the user's protected ACL but never
    /// occupy the supervisor instance or create directories in roaming storage.
    pub fn acquire_scoped(data_dir: &std::path::Path, scope: &str) -> Result<Self, RpcError> {
        crate::validate_lock_scope(scope)?;
        let security = UserSecurity::new()?;
        let attrs = security.attributes();
        let endpoint = crate::endpoint_key(data_dir)?;
        let name = if scope == "supervisor" {
            format!("Global\\StrataSupervisor-{endpoint}")
        } else {
            format!("Global\\StrataSupervisor-{endpoint}-{scope}")
        };
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe { CreateMutexW(&attrs, 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(RpcError::new(
                "instance_lock",
                std::io::Error::last_os_error().to_string(),
            ));
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                CloseHandle(handle);
            }
            return Err(RpcError::new("already_running", "当前用户后台已在运行"));
        }
        Ok(Self { handle })
    }
}
impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_pipe_acl_contains_only_current_user_and_never_inherits_handles() {
        use windows_sys::Win32::Security::{
            Authorization::ConvertSecurityDescriptorToStringSecurityDescriptorW,
            DACL_SECURITY_INFORMATION,
        };
        let security = UserSecurity::new().unwrap();
        assert_eq!(security.attributes().bInheritHandle, 0);
        let mut text = ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    security.descriptor,
                    1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    ptr::null_mut(),
                )
            },
            0
        );
        let mut len = 0;
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        let actual = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(text, len)) };
        unsafe {
            LocalFree(text as *mut c_void);
        }
        assert!(actual.starts_with("D:P(A;;GA;;;"));
        use windows_sys::Win32::Security::{GetAce, GetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE};
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = ptr::null_mut();
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(
                    security.descriptor,
                    &mut present,
                    &mut dacl,
                    &mut defaulted,
                )
            },
            0
        );
        assert_ne!(present, 0);
        assert!(!dacl.is_null());
        assert_eq!(unsafe { (*dacl).AceCount }, 1);
        let mut ace = ptr::null_mut();
        assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
        let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        assert_eq!(allowed.Header.AceType, 0);
        assert_eq!(allowed.Header.AceFlags, 0);
        assert_eq!(allowed.Mask, 0x10000000);
        let mut sid = ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertSidToStringSidW(
                    std::ptr::addr_of!(allowed.SidStart) as *mut c_void,
                    &mut sid,
                )
            },
            0
        );
        let mut len = 0;
        while unsafe { *sid.add(len) } != 0 {
            len += 1;
        }
        let identity = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(sid, len)) };
        unsafe {
            LocalFree(sid as *mut c_void);
        }
        assert_eq!(identity, current_identity().unwrap());
    }
}
